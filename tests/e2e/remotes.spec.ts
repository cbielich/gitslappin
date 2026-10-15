import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN } from './helpers/repo';
import {
  DIRTY_EDIT,
  SECRET,
  assertRemotesSafe,
  commitFile,
  configGet,
  createCredentialExtRemoteRepo,
  createCredentialRemoteRepo,
  createExtRemoteRepo,
  createNoRemoteRepo,
  createNoUpstreamBranch,
  createPullMergeInProgress,
  createPullRebaseInProgress,
  createRemoteFx,
  currentBranch,
  detachA,
  dirtyAndBehind,
  divergeClean,
  divergeConflict,
  extRan,
  fetchIn,
  fileText,
  git,
  hasRef,
  headSha,
  localCommit,
  originAdvance,
  originBranch,
  originDeleteBranch,
  originRef,
  originSnapshot,
  originTags,
  parentCount,
  refSha,
  stashCount,
  subjects,
} from './helpers/remoteFixtures';

/*
 * Test ids this file expects (new ones marked +). Existing: repo-view, commit-row, commit-message, ref-pill[data-name],
 * sidebar-item, context-menu, menu-item, toast, toast-title, toast-detail, tool-pull, tool-push, tool-branch, op-banner,
 * conflict-panel, conflict-title.
 *  tool-pull / tool-push keep these ids whatever their label is (Pull button label "Pull"; `title` = tooltip; `disabled` attribute).
 *  + pull-options-toggle                 (the caret of Pull; opens the Pull menu)
 *  + pull-options                        (the open Pull menu), pull-options-header (PullOptionsMessage text)
 *  + pull-option[data-mode=fetch|merge|ff-only|rebase]   (visible text = label; the saved default also has data-default="true")
 *  + toolbar-busy                        (spinner, present only while a remote request is in flight; Pull and Push disabled then)
 *  + upstream-bar                        (the slate confirm bar), upstream-message, upstream-remote (<select>, options = remote names),
 *    upstream-branch (<input>), upstream-error, upstream-submit ("Submit"), upstream-cancel ("Cancel")
 * Strings (en-us.json): PullOptionsMessage, PullOptions-FetchAll/-Merge/-FastForwardOnly/-Rebase, Pull, Push, ContextMenu-SetUpstream,
 *   Toolbar-PushNotAvailableInDetachedHead, Toolbar-Pull{Merge,FastForwardOnly,Rebase}NotAvailableInDetachedHead,
 *   SetUpstreamPrompt-SelectRemoteBranchMessage / -InvalidBranchName, SubmitButtonLabel, Error-FetchFailedWithName, Error-PullFailed,
 *   Error-PushFailed, Error-{Fetch,Pull,Push}FailedNoRemote, Notification-PulledSuccessfully / -PushedSuccessfully,
 *   PromptForPush-LocalIsBehindRemote.
 * UNVERIFIED (placeholder order, inferred): SetUpstreamPrompt {0}=local branch; PromptForPush {0}=local branch, {1}=remote branch
 *   ("'main' is behind 'origin/main'"); Error-FetchFailedWithName {0} = a name (remote or repo), only the shape is asserted;
 *   tooltips are the `title` attribute.
 * Server routes under /api/repos/:id: POST fetch, pull, push, upstream, GET remotes; GET/PUT /api/prefs.
 * HTTP status for refused input is not fixed by the design, so refusals are asserted as 4xx plus "nothing changed".
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

const L = {
  pullHeader: 'Select a default pull/fetch operation to execute when clicking this button',
  fetchAll: 'Fetch All',
  merge: 'Pull (fast-forward if possible)',
  ffOnly: 'Pull (fast-forward only)',
  rebase: 'Pull (rebase)',
  setUpstream: 'Set Upstream',
  pulled: 'Pulled Successfully',
  pushed: 'Pushed Successfully',
  pullFailed: 'Pull Failed',
  pushFailed: 'Push Failed',
  invalidBranch: 'The given branch name is not valid',
  noRemotePull: 'There are no remotes to pull from, would you like to add one?',
  noRemotePush: 'There are no remotes to push to, would you like to add one?',
  noRemoteFetch: 'There are no remotes to fetch from, would you like to add one?',
  detachedPush: 'Push is not available when in a detached HEAD state',
  detachedMerge: 'Pull (fast-forward if possible) is not available when in a detached HEAD state',
  detachedFf: 'Pull (fast-forward only) is not available when in a detached HEAD state',
  detachedRebase: 'Pull (rebase) is not available when in a detached HEAD state',
} as const;

type Mode = 'merge' | 'ff-only' | 'rebase';

async function setMode(request: APIRequestContext, mode: Mode): Promise<void> {
  const res = await request.put('/api/prefs', { headers, data: { pullMode: mode } });
  expect(res.status()).toBe(200);
}
async function getMode(request: APIRequestContext): Promise<unknown> {
  const res = await request.get('/api/prefs', { headers });
  expect(res.status()).toBe(200);
  return res.json();
}

async function openGraph(page: Page, repo: string, mode: Mode = 'merge'): Promise<void> {
  await setMode(page.request, mode);
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
const post = (request: APIRequestContext, id: string, route: string, data: unknown) =>
  request.post(`/api/repos/${id}/${route}`, { headers, data: data as object });

const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`).first(); // origin/<name> shows under the same short name; the local row is the first
const menuItem = (page: Page, text: string) =>
  page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) });
async function menuLabels(page: Page): Promise<string[]> {
  return page.getByTestId('context-menu').getByTestId('menu-item').evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/[›>]/g, '').trim()));
}
const option = (page: Page, mode: 'fetch' | Mode) => page.locator(`[data-testid="pull-option"][data-mode="${mode}"]`);
async function pickFromPullMenu(page: Page, mode: 'fetch' | Mode): Promise<void> {
  await page.getByTestId('pull-options-toggle').click();
  await expect(page.getByTestId('pull-options')).toBeVisible();
  await option(page, mode).click();
}
const toastTitle = (page: Page) => page.getByTestId('toast-title');

test.describe('prefs (pull mode, one per user)', () => {
  test('default is merge; GET/PUT round-trip; only {pullMode, theme, zoom} is stored', async ({ request }) => {
    expect(await getMode(request)).toEqual({ pullMode: 'merge', theme: 'dark', zoom: 1 }); // first test of the file: nothing has saved a mode yet
    for (const mode of ['rebase', 'ff-only', 'merge'] as const) {
      await setMode(request, mode);
      expect(await getMode(request)).toEqual({ pullMode: mode, theme: 'dark', zoom: 1 });
    }
  });

  test('rejects values outside the enum and leaves the saved mode alone', async ({ request }) => {
    await setMode(request, 'ff-only');
    for (const bad of ['force', '', 'MERGE', '--upload-pack=x', 7, null, ['merge'], { a: 1 }]) {
      const res = await request.put('/api/prefs', { headers, data: { pullMode: bad } });
      expect(res.status(), JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
    const noMode = await request.put('/api/prefs', { headers, data: {} });
    expect(noMode.status()).toBeGreaterThanOrEqual(400);
    expect(await getMode(request)).toEqual({ pullMode: 'ff-only', theme: 'dark', zoom: 1 });
  });

  test('extra keys are never stored or echoed (no spreading of the body)', async ({ request }) => {
    await request.put('/api/prefs', { headers, data: { pullMode: 'rebase', evil: 'x', __proto__: { polluted: true }, constructor: { prototype: { polluted: true } } } });
    const body = (await getMode(request)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['pullMode', 'theme', 'zoom']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await setMode(request, 'merge');
  });

  test('an oversized body is refused and nothing changes', async ({ request }) => {
    await setMode(request, 'merge');
    const res = await request.put('/api/prefs', { headers, data: { pullMode: 'rebase', pad: 'x'.repeat(300_000) } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    expect(await getMode(request)).toEqual({ pullMode: 'merge', theme: 'dark', zoom: 1 });
  });

  test('prefs need the token', async ({ request }) => {
    const res = await request.get('/api/prefs');
    expect(res.status()).toBe(403);
  });
});

test.describe('Pull menu and fetch', () => {
  test('toolbar Pull shows its label and the caret menu has the header and the four exact items', async ({ page }) => {
    const fx = createRemoteFx();
    await openGraph(page, fx.a);
    await expect(page.getByTestId('tool-pull')).toContainText('Pull');
    await expect(page.getByTestId('tool-push')).toContainText('Push');
    await expect(page.getByTestId('tool-pull')).toBeEnabled();
    await expect(page.getByTestId('tool-push')).toBeEnabled();
    await expect(page.getByTestId('toolbar-busy')).toHaveCount(0);
    await page.getByTestId('pull-options-toggle').click();
    await expect(page.getByTestId('pull-options-header')).toHaveText(L.pullHeader);
    await expect(option(page, 'fetch')).toHaveText(L.fetchAll);
    await expect(option(page, 'merge')).toHaveText(L.merge);
    await expect(option(page, 'ff-only')).toHaveText(L.ffOnly);
    await expect(option(page, 'rebase')).toHaveText(L.rebase);
    await expect(option(page, 'merge')).toHaveAttribute('data-default', 'true');
    await expect(option(page, 'rebase')).not.toHaveAttribute('data-default', 'true');
  });

  test('Fetch All fetches new commits, prunes stale remote-tracking refs, and changes nothing local', async ({ page }) => {
    const fx = createRemoteFx();
    originBranch(fx, 'old');
    fetchIn(fx.a);
    git(fx.a, ['branch', '--track', 'old', 'origin/old']);
    const sha = originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    originDeleteBranch(fx, 'old');
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await pickFromPullMenu(page, 'fetch');
    await expect.poll(() => refSha(fx.a, 'origin/main')).toBe(sha);
    expect(hasRef(fx.a, 'refs/remotes/origin/old')).toBe(false);
    expect(hasRef(fx.a, 'refs/heads/old')).toBe(true);
    expect(headSha(fx.a)).toBe(fx.baseSha);
    expect(await getMode(page.request)).toEqual({ pullMode: 'merge', theme: 'dark', zoom: 1 }); // Fetch All is not a pull mode
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('Fetch failing shows Error-FetchFailedWithName; no remote shows the NoRemote message', async ({ page }) => {
    const repo = createNoRemoteRepo();
    await openGraph(page, repo);
    await pickFromPullMenu(page, 'fetch');
    await expect(page.getByTestId('toast')).toContainText(L.noRemoteFetch);
  });

  test('while a request is in flight the toolbar shows the spinner and Pull and Push are disabled', async ({ page }) => {
    const fx = createRemoteFx();
    originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    await openGraph(page, fx.a);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/api/repos/*/pull', async (route) => {
      await gate;
      await route.continue();
    });
    assertRemotesSafe(fx.a);
    await page.getByTestId('tool-pull').click();
    await expect(page.getByTestId('toolbar-busy')).toBeVisible();
    await expect(page.getByTestId('tool-pull')).toBeDisabled();
    await expect(page.getByTestId('tool-push')).toBeDisabled();
    release();
    await expect(page.getByTestId('toolbar-busy')).toHaveCount(0);
    await expect(page.getByTestId('tool-pull')).toBeEnabled();
    await expect(page.getByTestId('tool-push')).toBeEnabled();
  });
});

test.describe('pull modes', () => {
  test('Pull (fast-forward if possible) fast-forwards, toasts success and saves the mode', async ({ page }) => {
    const fx = createRemoteFx();
    const sha = originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    await openGraph(page, fx.a, 'rebase');
    assertRemotesSafe(fx.a);
    await pickFromPullMenu(page, 'merge');
    await expect.poll(() => headSha(fx.a)).toBe(sha);
    expect(parentCount(fx.a)).toBe(1);
    await expect(toastTitle(page)).toHaveText(L.pulled);
    expect(await getMode(page.request)).toEqual({ pullMode: 'merge', theme: 'dark', zoom: 1 });
  });

  test('Pull (fast-forward if possible) on diverged branches makes a merge commit', async ({ page }) => {
    const fx = createRemoteFx();
    divergeClean(fx);
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await pickFromPullMenu(page, 'merge');
    await expect.poll(() => parentCount(fx.a)).toBe(2);
    await expect(toastTitle(page)).toHaveText(L.pulled);
  });

  test('Pull (fast-forward only) fails on divergence: Pull Failed toast with git text, nothing changed, mode saved', async ({ page }) => {
    const fx = createRemoteFx();
    divergeClean(fx);
    const before = headSha(fx.a);
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await pickFromPullMenu(page, 'ff-only');
    await expect(toastTitle(page)).toHaveText(L.pullFailed);
    await expect(page.getByTestId('toast-detail')).not.toHaveText('');
    expect(headSha(fx.a)).toBe(before);
    expect(parentCount(fx.a)).toBe(1);
    await expect(page.getByTestId('op-banner')).toHaveCount(0);
    expect(await getMode(page.request)).toEqual({ pullMode: 'ff-only', theme: 'dark', zoom: 1 });
  });

  test('Pull (rebase) puts the local commit on top of origin', async ({ page }) => {
    const fx = createRemoteFx();
    const { remoteSha } = divergeClean(fx);
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await pickFromPullMenu(page, 'rebase');
    await expect.poll(() => refSha(fx.a, 'HEAD~1')).toBe(remoteSha); // the subject alone is true before the rebase, so wait for the new parent
    expect(subjects(fx.a)[0]).toBe('Local side commit');
    expect(parentCount(fx.a)).toBe(1);
    await expect(toastTitle(page)).toHaveText(L.pulled);
    expect(await getMode(page.request)).toEqual({ pullMode: 'rebase', theme: 'dark', zoom: 1 });
  });

  test('the Pull button itself runs the saved mode', async ({ page }) => {
    const fx = createRemoteFx();
    const { remoteSha } = divergeClean(fx);
    await openGraph(page, fx.a, 'rebase');
    assertRemotesSafe(fx.a);
    await page.getByTestId('tool-pull').click();
    await expect.poll(() => refSha(fx.a, 'HEAD~1')).toBe(remoteSha); // the subject alone is true before the rebase, so wait for the new parent
    expect(subjects(fx.a)[0]).toBe('Local side commit');
  });

  test('the chosen mode is remembered across a page reload', async ({ page }) => {
    const fx = createRemoteFx();
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await pickFromPullMenu(page, 'rebase');
    await expect(toastTitle(page)).toHaveText(L.pulled);
    await page.reload();
    await expect(page.getByTestId('repo-view')).toBeVisible();
    await page.getByTestId('pull-options-toggle').click();
    await expect(option(page, 'rebase')).toHaveAttribute('data-default', 'true');
    await expect(option(page, 'merge')).not.toHaveAttribute('data-default', 'true');
    expect(await getMode(page.request)).toEqual({ pullMode: 'rebase', theme: 'dark', zoom: 1 });
  });

  test('a pull conflict (merge) opens the phase 6 merge screens, with no failure toast', async ({ page }) => {
    const fx = createRemoteFx();
    divergeConflict(fx);
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await page.getByTestId('tool-pull').click();
    await expect(page.getByTestId('op-banner')).toBeVisible();
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('conflict-panel')).toBeVisible();
    await expect(page.getByTestId('conflict-title')).toHaveText('Merge conflicts detected');
    await expect(page.getByTestId('conflict-conflicted')).toContainText('Conflicted Files (1)');
    expect(fileText(fx.a, 'src/config.js')).toContain('<<<<<<<');
  });

  test('a pull conflict (rebase) opens the phase 6 rebase screens', async ({ page }) => {
    const fx = createRemoteFx();
    divergeConflict(fx);
    await openGraph(page, fx.a, 'rebase');
    assertRemotesSafe(fx.a);
    await page.getByTestId('tool-pull').click();
    await expect(page.getByTestId('op-banner')).toBeVisible();
    await page.getByTestId('op-banner').click();
    await expect(page.getByTestId('conflict-title')).toHaveText('Rebase conflicts detected');
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  for (const mode of ['merge', 'ff-only', 'rebase'] as const) {
    test(`dirty tree (${mode}): git refuses, Pull Failed shows its text, the edit survives and nothing is stashed`, async ({ page }) => {
      const fx = createRemoteFx();
      dirtyAndBehind(fx);
      const before = headSha(fx.a);
      await openGraph(page, fx.a, mode);
      assertRemotesSafe(fx.a);
      await page.getByTestId('tool-pull').click();
      await expect(toastTitle(page)).toHaveText(L.pullFailed);
      await expect(page.getByTestId('toast-detail')).not.toHaveText('');
      expect(fileText(fx.a, 'README.md')).toBe(DIRTY_EDIT);
      expect(stashCount(fx.a)).toBe(0);
      expect(headSha(fx.a)).toBe(before);
    });
  }

  test('a branch with no remote shows the Error-PullFailedNoRemote message', async ({ page }) => {
    const repo = createNoRemoteRepo();
    await openGraph(page, repo);
    await page.getByTestId('tool-pull').click();
    await expect(page.getByTestId('toast')).toContainText(L.noRemotePull);
  });

  test('pull with no upstream asks for one (the bar) and pulls nothing until submitted', async ({ page }) => {
    const fx = createRemoteFx();
    createNoUpstreamBranch(fx);
    originAdvance(fx, { 'new.txt': 'n\n' }, 'Remote new');
    const before = headSha(fx.a);
    await openGraph(page, fx.a);
    await page.getByTestId('tool-pull').click();
    await expect(page.getByTestId('upstream-bar')).toBeVisible();
    await page.getByTestId('upstream-cancel').click();
    await expect(page.getByTestId('upstream-bar')).toHaveCount(0);
    expect(headSha(fx.a)).toBe(before);
    expect(configGet(fx.a, 'branch.feature/x.remote')).toBeUndefined();
  });
});

test.describe('push', () => {
  test('Push sends new commits to the upstream and toasts success', async ({ page }) => {
    const fx = createRemoteFx();
    const sha = localCommit(fx, { 'more.txt': 'm\n' }, 'Local ahead');
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await page.getByTestId('tool-push').click();
    await expect(toastTitle(page)).toHaveText(L.pushed);
    expect(originRef(fx, 'refs/heads/main')).toBe(sha);
  });

  test('first push of a branch shows the upstream bar; an invalid name is flagged; Cancel pushes nothing', async ({ page }) => {
    const fx = createRemoteFx();
    createNoUpstreamBranch(fx);
    const before = originSnapshot(fx);
    await openGraph(page, fx.a);
    await page.getByTestId('tool-push').click();
    await expect(page.getByTestId('upstream-bar')).toBeVisible();
    await expect(page.getByTestId('upstream-message')).toHaveText('What remote/branch should "feature/x" push to and pull from?');
    await expect(page.getByTestId('upstream-remote').locator('option')).toHaveText(['origin']);
    await expect(page.getByTestId('upstream-submit')).toHaveText('Submit');
    await expect(page.getByTestId('upstream-cancel')).toHaveText('Cancel');
    await page.getByTestId('upstream-branch').fill('bad name');
    await page.getByTestId('upstream-submit').click();
    await expect(page.getByTestId('upstream-error')).toHaveText(L.invalidBranch);
    expect(originSnapshot(fx)).toBe(before);
    await page.getByTestId('upstream-cancel').click();
    await expect(page.getByTestId('upstream-bar')).toHaveCount(0);
    expect(originSnapshot(fx)).toBe(before);
  });

  test('submitting the upstream bar pushes the branch, sets the upstream and toasts success', async ({ page }) => {
    const fx = createRemoteFx();
    const sha = createNoUpstreamBranch(fx);
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await page.getByTestId('tool-push').click();
    await expect(page.getByTestId('upstream-bar')).toBeVisible();
    await page.getByTestId('upstream-branch').fill('feature/x');
    await page.getByTestId('upstream-submit').click();
    await expect(toastTitle(page)).toHaveText(L.pushed);
    await expect(page.getByTestId('upstream-bar')).toHaveCount(0);
    expect(originRef(fx, 'refs/heads/feature/x')).toBe(sha);
    expect(configGet(fx.a, 'branch.feature/x.remote')).toBe('origin');
    expect(configGet(fx.a, 'branch.feature/x.merge')).toBe('refs/heads/feature/x');
  });

  test('a non-fast-forward push shows Push Failed with the "is behind" detail and origin is untouched', async ({ page }) => {
    const fx = createRemoteFx();
    const remote = originAdvance(fx, { 'remote.txt': 'r\n' }, 'Remote side commit');
    const local = localCommit(fx, { 'local.txt': 'l\n' }, 'Local side commit');
    const before = originSnapshot(fx);
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await page.getByTestId('tool-push').click();
    await expect(toastTitle(page)).toHaveText(L.pushFailed);
    await expect(page.getByTestId('toast-detail')).toContainText(/'main' is behind '(origin\/)?main'\. Update your branch by doing a Pull\./);
    expect(originSnapshot(fx)).toBe(before);
    expect(originRef(fx, 'refs/heads/main')).toBe(remote);
    expect(headSha(fx.a)).toBe(local);
  });

  test('tags are not pushed (push.followTags=true is overridden)', async ({ page }) => {
    const fx = createRemoteFx();
    const sha = localCommit(fx, { 'more.txt': 'm\n' }, 'Tagged commit');
    git(fx.a, ['tag', '-a', 'v1.0', '-m', 'release']);
    expect(configGet(fx.a, 'push.followTags')).toBe('true');
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await page.getByTestId('tool-push').click();
    await expect(toastTitle(page)).toHaveText(L.pushed);
    expect(originRef(fx, 'refs/heads/main')).toBe(sha);
    expect(originTags(fx)).toEqual([]);
  });

  test('a repo with no remote shows the Error-PushFailedNoRemote message', async ({ page }) => {
    const repo = createNoRemoteRepo();
    await openGraph(page, repo);
    await page.getByTestId('tool-push').click();
    await expect(page.getByTestId('toast')).toContainText(L.noRemotePush);
  });
});

test.describe('detached HEAD', () => {
  const cases: [Mode, string][] = [
    ['merge', L.detachedMerge],
    ['ff-only', L.detachedFf],
    ['rebase', L.detachedRebase],
  ];
  for (const [mode, tip] of cases) {
    test(`Pull (${mode}) and Push are disabled with their tooltips`, async ({ page }) => {
      const fx = createRemoteFx();
      detachA(fx);
      await openGraph(page, fx.a, mode);
      await expect(page.getByTestId('tool-branch')).toBeEnabled(); // the toolbar is live, only these two are off
      await expect(page.getByTestId('tool-pull')).toBeDisabled();
      await expect(page.getByTestId('tool-pull')).toHaveAttribute('title', tip);
      await expect(page.getByTestId('tool-push')).toBeDisabled();
      await expect(page.getByTestId('tool-push')).toHaveAttribute('title', L.detachedPush);
    });
  }
});

test.describe('menu Remote group', () => {
  test('a branch pill offers Pull, Push and Set Upstream', async ({ page }) => {
    const fx = createRemoteFx();
    await openGraph(page, fx.a);
    await pill(page, 'main').click({ button: 'right' });
    await expect(menuItem(page, L.merge)).toBeVisible();
    await expect(menuItem(page, 'Push')).toBeVisible();
    await expect(menuItem(page, L.setUpstream)).toBeVisible();
  });

  test('Push from the menu pushes the current branch', async ({ page }) => {
    const fx = createRemoteFx();
    const sha = localCommit(fx, { 'more.txt': 'm\n' }, 'Local ahead');
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await pill(page, 'main').click({ button: 'right' });
    await menuItem(page, 'Push').click();
    await expect(toastTitle(page)).toHaveText(L.pushed);
    expect(originRef(fx, 'refs/heads/main')).toBe(sha);
  });

  test('Pull on a branch that is not current fast-forwards only that branch', async ({ page }) => {
    const fx = createRemoteFx();
    originBranch(fx, 'feature');
    fetchIn(fx.a);
    git(fx.a, ['branch', '--track', 'feature', 'origin/feature']);
    git(fx.b, ['switch', 'feature']);
    const tip2 = commitFile(fx.b, { 'more.txt': 'm\n' }, 'Feature advances', 'Other Author');
    git(fx.b, ['push', 'origin', 'feature']);
    await openGraph(page, fx.a);
    assertRemotesSafe(fx.a);
    await pill(page, 'feature').click({ button: 'right' });
    await menuItem(page, L.merge).click();
    await expect(toastTitle(page)).toHaveText(L.pulled);
    expect(refSha(fx.a, 'refs/heads/feature')).toBe(tip2);
    expect(currentBranch(fx.a)).toBe('main');
    expect(headSha(fx.a)).toBe(fx.baseSha);
  });

  test('Set Upstream opens the bar and Submit writes the tracking config without pushing', async ({ page }) => {
    const fx = createRemoteFx();
    createNoUpstreamBranch(fx, 'later');
    const before = originSnapshot(fx);
    await openGraph(page, fx.a);
    await pill(page, 'later').click({ button: 'right' });
    await menuItem(page, L.setUpstream).click();
    await expect(page.getByTestId('upstream-bar')).toBeVisible();
    await expect(page.getByTestId('upstream-message')).toHaveText('What remote/branch should "later" push to and pull from?');
    await page.getByTestId('upstream-branch').fill('later');
    await page.getByTestId('upstream-submit').click();
    await expect(page.getByTestId('upstream-bar')).toHaveCount(0);
    await expect.poll(() => configGet(fx.a, 'branch.later.remote')).toBe('origin');
    expect(configGet(fx.a, 'branch.later.merge')).toBe('refs/heads/later');
    expect(originSnapshot(fx)).toBe(before);
  });

  test('the Remote items are hidden when HEAD is detached (the menu itself still opens)', async ({ page }) => {
    const fx = createRemoteFx();
    git(fx.a, ['switch', '--detach', 'HEAD~1']); // not at main's tip, so main keeps its own pill (at the tip HEAD takes the pill and main moves into +N)
    await openGraph(page, fx.a);
    await pill(page, 'main').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    const labels = await menuLabels(page);
    expect(labels).toContain('Copy branch name');
    expect(labels).not.toContain('Push');
    expect(labels).not.toContain(L.setUpstream);
    expect(labels).not.toContain(L.merge);
  });

  test('the Remote items are hidden while an operation is in progress', async ({ page }) => {
    const fx = createPullMergeInProgress();
    await openGraph(page, fx.a);
    await pill(page, 'main').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    const labels = await menuLabels(page);
    expect(labels).toContain('Copy branch name');
    expect(labels).not.toContain('Push');
    expect(labels).not.toContain(L.setUpstream);
    expect(labels).not.toContain(L.merge);
  });
});

test.describe('remote routes, hostile input (API)', () => {
  const BAD = ['a:b', 'a+b', 'a*b', 'a^b', 'a?b', 'a[b', 'a\\b', 'a~b', 'a..b', 'a@{b', '-x', 'a\u0001b', 'a/', 'x.lock', 'main:refs/heads/evil', '+main', ':main', ''];
  const refused = (status: number): void => {
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  };

  test('push refuses refspec characters, empty and missing sources; origin never changes', async ({ request }) => {
    const fx = createRemoteFx();
    const id = await openRepoApi(request, fx.a);
    const before = originSnapshot(fx);
    for (const bad of BAD) {
      refused((await post(request, id, 'push', { branch: bad, remote: 'origin', remoteBranch: 'main' })).status());
      refused((await post(request, id, 'push', { branch: 'main', remote: 'origin', remoteBranch: bad })).status());
    }
    refused((await post(request, id, 'push', { branch: 'ghost', remote: 'origin', remoteBranch: 'main' })).status());
    expect(originSnapshot(fx)).toBe(before);
    expect(originRef(fx, 'refs/heads/main')).toBe(fx.baseSha);
    // the code path is alive: a valid push still works
    const sha = localCommit(fx, { 'more.txt': 'm\n' }, 'Local ahead');
    assertRemotesSafe(fx.a);
    const ok = await post(request, id, 'push', {});
    expect(ok.status()).toBe(200);
    expect(originRef(fx, 'refs/heads/main')).toBe(sha);
  });

  test('push refuses remotes that are unknown or look like options', async ({ request }) => {
    const fx = createRemoteFx();
    const id = await openRepoApi(request, fx.a);
    const before = originSnapshot(fx);
    for (const remote of ['nope', '--upload-pack=touch x', '-oProxyCommand=x', '', 'origin:x']) {
      refused((await post(request, id, 'push', { branch: 'main', remote, remoteBranch: 'main' })).status());
    }
    expect(originSnapshot(fx)).toBe(before);
  });

  test('push without an upstream answers 409 needsUpstream with the remotes, and pushes nothing', async ({ request }) => {
    const fx = createRemoteFx();
    createNoUpstreamBranch(fx);
    const id = await openRepoApi(request, fx.a);
    const before = originSnapshot(fx);
    assertRemotesSafe(fx.a);
    const res = await post(request, id, 'push', {});
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { needsUpstream?: boolean; remotes?: unknown };
    expect(body.needsUpstream).toBe(true);
    expect(JSON.stringify(body.remotes)).toContain('origin');
    expect(originSnapshot(fx)).toBe(before);
  });

  test('a non-ff push answers rejected "non-ff" and origin is unchanged', async ({ request }) => {
    const fx = createRemoteFx();
    originAdvance(fx, { 'remote.txt': 'r\n' }, 'Remote side commit');
    localCommit(fx, { 'local.txt': 'l\n' }, 'Local side commit');
    const id = await openRepoApi(request, fx.a);
    const before = originSnapshot(fx);
    assertRemotesSafe(fx.a);
    const res = await post(request, id, 'push', {});
    expect(((await res.json()) as { rejected?: string }).rejected).toBe('non-ff');
    expect(originSnapshot(fx)).toBe(before);
  });

  test('pull refuses an unknown mode, answers 409 when detached and while a merge is in progress', async ({ request }) => {
    const fx = createRemoteFx();
    const id = await openRepoApi(request, fx.a);
    refused((await post(request, id, 'pull', { mode: 'force' })).status());
    refused((await post(request, id, 'pull', { mode: 'merge', branch: '--upload-pack=x' })).status());
    detachA(fx);
    expect((await post(request, id, 'pull', { mode: 'merge' })).status()).toBe(409);
    expect(headSha(fx.a)).toBe(fx.baseSha);

    const busy = createPullMergeInProgress();
    const busyId = await openRepoApi(request, busy.a);
    expect((await post(request, busyId, 'pull', { mode: 'merge' })).status()).toBe(409);
    expect((await post(request, busyId, 'pull', { mode: 'rebase' })).status()).toBe(409);
    const rb = createPullRebaseInProgress();
    const rbId = await openRepoApi(request, rb.a);
    expect((await post(request, rbId, 'pull', { mode: 'merge' })).status()).toBe(409);
  });

  test('upstream validates the branch and names; valid input writes the tracking config', async ({ request }) => {
    const fx = createRemoteFx();
    createNoUpstreamBranch(fx, 'later');
    const id = await openRepoApi(request, fx.a);
    refused((await post(request, id, 'upstream', { branch: 'ghost', remote: 'origin', remoteBranch: 'x' })).status());
    refused((await post(request, id, 'upstream', { branch: 'later', remote: 'origin', remoteBranch: 'a:b' })).status());
    refused((await post(request, id, 'upstream', { branch: 'later', remote: 'origin', remoteBranch: '-x' })).status());
    refused((await post(request, id, 'upstream', { branch: 'later', remote: 'nope', remoteBranch: 'x' })).status());
    expect(configGet(fx.a, 'branch.later.remote')).toBeUndefined();
    const ok = await post(request, id, 'upstream', { branch: 'later', remote: 'origin', remoteBranch: 'later' });
    expect(ok.status()).toBe(200);
    expect(configGet(fx.a, 'branch.later.merge')).toBe('refs/heads/later');
  });

  test('GET remotes hides credentials in urls', async ({ request }) => {
    const { repo } = createCredentialRemoteRepo();
    const id = await openRepoApi(request, repo);
    const res = await request.get(`/api/repos/${id}/remotes`, { headers });
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('creds'); // the remote is listed
    expect(text).toContain('***@example.invalid');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('alice');
  });

  test('fetch refuses an ext:: remote, never runs its command, and leaks no credentials', async ({ request }) => {
    const ext = createExtRemoteRepo();
    const extId = await openRepoApi(request, ext.repo);
    const res = await post(request, extId, 'fetch', {});
    const body = await res.text();
    expect(res.status() >= 400 || /"error"/.test(body)).toBe(true); // the refusal path ran
    expect(extRan(ext.marker)).toBe(false);

    const cred = createCredentialExtRemoteRepo();
    const credId = await openRepoApi(request, cred.repo);
    const res2 = await post(request, credId, 'fetch', {});
    const body2 = await res2.text();
    expect(res2.status() >= 400 || /"error"/.test(body2)).toBe(true);
    expect(body2).not.toContain(SECRET);
  });
});

test.describe('Fetch failure toast', () => {
  test('fetch of an unreachable ext:: remote shows Error-FetchFailedWithName in the UI', async ({ page }) => {
    const ext = createExtRemoteRepo();
    await openGraph(page, ext.repo);
    await pickFromPullMenu(page, 'fetch');
    await expect(toastTitle(page)).toHaveText(/^Fetch failed for '.+'$/);
    expect(extRan(ext.marker)).toBe(false);
  });
});
