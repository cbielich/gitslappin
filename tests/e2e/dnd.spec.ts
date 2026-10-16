import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN } from './helpers/repo';
import { configGet, currentBranch, git, headSha, originRef, parentCount, refSha, subjects, tryGit } from './helpers/remoteFixtures';
import { FEATURE_SUBJECT, createDndFx, createPushDndFx } from './helpers/interactionFixtures';

/*
 * V6 "1 Drag and drop" (native HTML5 DnD) + audit data-safety 3, 4 and security 5. Fixtures: helpers/interactionFixtures.ts.
 * Existing test ids: repo-view, commit-row, ref-pill[data-name], sidebar-item[data-kind][data-name], sidebar-toggle-<id>, context-menu, menu-item[data-id], tool-undo, toast, toast-title,
 *   confirm-bar[data-kind].
 * NEW (+) the builder must implement:
 *  + draggable branch sources: every ref-pill (graph) and every sidebar-item[data-kind=local|remote] has draggable="true" and carries the dragged branch only in IN-APP state (audit security 5).
 *  + drop targets: the same elements. While a drag hovers a valid target it gets data-drop-target="true" (removed on leave / drop / dragend) -- "targets highlight on drag-over".
 *  + the drop menu is the existing context-menu at the drop point; its menu-item[data-id] are:
 *      merge-branch-into-branch   "Merge <src> into <HEAD>"
 *      rebase-branch-onto-branch  "Rebase <HEAD> onto <dst>"
 *      rebase-branch-onto-branch-interactively  "Interactive Rebase <HEAD> onto <dst>" (only git >= 2.38; not asserted here)
 *      push-x-to-y                "Push <src> to <dst>"
 * Behaviour asserted: nothing runs on drop (only on the menu click); merge makes a merge commit; rebase goes through the existing path (journaled: tool-undo restores the old tip);
 *   push goes with upstream:false (no branch.<x>.remote written); a rejected drop-push shows an error toast and offers no Force Push; no menu on self; an external-only drop is ignored.
 * UNVERIFIED: the Playwright mouse-drag sequence below drives native dragstart/dragover/drop in Chromium (it does for dragTo); the highlight test uses the manual mouse sequence.
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };
const item = (page: Page, id: string) => page.locator(`[data-testid="menu-item"][data-id="${id}"]`);
const sbLocal = (page: Page, name: string) => page.locator(`[data-testid="sidebar-item"][data-kind="local"][data-name="${name}"]`);
const sbRemote = (page: Page, name: string) => page.locator(`[data-testid="sidebar-item"][data-kind="remote"][data-name$="${name}"]`);
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`).first();

async function openGraph(page: Page, repo: string): Promise<void> {
  const res = await page.request.put('/api/prefs', { headers, data: { autoFetchMinutes: 0 } }); // no background fetch changes a fixture
  expect(res.status()).toBe(200);
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

test.describe('drag a branch onto another', () => {
  test('onto the checked-out branch: only "Merge X into HEAD"; nothing runs until it is clicked; then a merge commit is made', async ({ page }) => {
    const fx = createDndFx();
    const before = headSha(fx.a);
    await openGraph(page, fx.a);
    await pill(page, 'feature/x').dragTo(pill(page, 'main'));
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await expect(page.getByTestId('menu-item')).toHaveCount(1);
    await expect(item(page, 'merge-branch-into-branch')).toHaveText('Merge feature/x into main');
    expect(headSha(fx.a)).toBe(before); // nothing ran on drop
    expect(parentCount(fx.a)).toBe(1);
    await item(page, 'merge-branch-into-branch').click();
    await expect.poll(() => parentCount(fx.a)).toBe(2);
    expect(currentBranch(fx.a)).toBe('main');
    expect(git(fx.a, ['merge-base', '--is-ancestor', fx.featureSha, 'HEAD'])).toBe('');
    expect(subjects(fx.a)).toContain(FEATURE_SUBJECT);
  });

  test('Esc closes the drop menu and nothing happens', async ({ page }) => {
    const fx = createDndFx();
    const before = headSha(fx.a);
    await openGraph(page, fx.a);
    await expandSections(page);
    await sbLocal(page, 'feature/x').dragTo(sbLocal(page, 'main'));
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
    expect(headSha(fx.a)).toBe(before);
    expect(parentCount(fx.a)).toBe(1);
  });

  test('HEAD dropped on another branch: Rebase HEAD onto it via the existing rebase path; like GitKraken (and phase 10) a rebase is not undoable, but the old commit still exists', async ({ page }) => {
    const fx = createDndFx({ checkout: 'feature/x' });
    await openGraph(page, fx.a);
    await expandSections(page);
    await sbLocal(page, 'feature/x').dragTo(sbLocal(page, 'main'));
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await expect(item(page, 'rebase-branch-onto-branch')).toHaveText('Rebase feature/x onto main');
    await expect(item(page, 'merge-branch-into-branch')).toHaveCount(0); // dst is not checked out
    await expect(item(page, 'push-x-to-y')).toHaveCount(0);
    expect(refSha(fx.a, 'feature/x')).toBe(fx.featureSha); // nothing ran on drop
    await item(page, 'rebase-branch-onto-branch').click();
    await expect.poll(() => refSha(fx.a, 'feature/x')).not.toBe(fx.featureSha);
    expect(git(fx.a, ['rev-parse', 'feature/x~1']).trim()).toBe(fx.mainMoved); // replayed on top of main
    expect(currentBranch(fx.a)).toBe('feature/x');
    // GitKraken: 'Only commit (with a parent), checkout, and some discard operations' can be undone; phase 10 records no rebase.
    await expect(page.getByTestId('tool-undo')).toBeDisabled();
    git(fx.a, ['cat-file', '-e', fx.featureSha + '^{commit}']); // the pre-rebase commit is still in the repo
  });

  test('a branch dropped on itself shows no menu and runs nothing', async ({ page }) => {
    const fx = createDndFx();
    const before = headSha(fx.a);
    await openGraph(page, fx.a);
    await expandSections(page);
    await sbLocal(page, 'main').dragTo(sbLocal(page, 'main'));
    await sbLocal(page, 'feature/x').dragTo(sbLocal(page, 'feature/x'));
    await pill(page, 'main').dragTo(pill(page, 'main'));
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
    expect(headSha(fx.a)).toBe(before);
  });

  test('a local branch dropped on a local branch that is neither source nor checked out: no menu', async ({ page }) => {
    const fx = createDndFx();
    git(fx.a, ['branch', 'third', 'main']);
    await openGraph(page, fx.a);
    await expandSections(page);
    await sbLocal(page, 'feature/x').dragTo(sbLocal(page, 'third'));
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
  });

  test('the target highlights while the drag hovers it (data-drop-target) and the highlight goes away on drop', async ({ page }) => {
    const fx = createDndFx();
    await openGraph(page, fx.a);
    await expandSections(page);
    const src = sbLocal(page, 'feature/x');
    const dst = sbLocal(page, 'main');
    await expect(dst).not.toHaveAttribute('data-drop-target', 'true');
    const s = (await src.boundingBox())!;
    const d = (await dst.boundingBox())!;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width / 2 + 5, s.y + s.height / 2 + 5, { steps: 3 });
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 8 });
    await expect(dst).toHaveAttribute('data-drop-target', 'true');
    await page.mouse.up();
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await expect(dst).not.toHaveAttribute('data-drop-target', 'true');
    await page.keyboard.press('Escape');
  });
});

test.describe('drag a local branch onto a remote branch: push', () => {
  test('Push X to Y runs with upstream:false: the branch arrives on origin and no upstream is written', async ({ page }) => {
    const fx = createPushDndFx();
    expect(originRef(fx, 'refs/heads/x')).toBe(fx.originXSha);
    expect(configGet(fx.a, 'branch.x2.remote')).toBeUndefined();
    await openGraph(page, fx.a);
    await expandSections(page);
    await sbLocal(page, 'x2').dragTo(sbRemote(page, 'origin/x'));
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await expect(page.getByTestId('menu-item')).toHaveCount(1);
    await expect(item(page, 'push-x-to-y')).toHaveText('Push x2 to origin/x');
    expect(originRef(fx, 'refs/heads/x')).toBe(fx.originXSha); // nothing ran on drop
    await item(page, 'push-x-to-y').click();
    await expect.poll(() => originRef(fx, 'refs/heads/x')).toBe(fx.x2Sha);
    expect(configGet(fx.a, 'branch.x2.remote')).toBeUndefined(); // the upstream is left alone
    expect(configGet(fx.a, 'branch.x2.merge')).toBeUndefined();
    expect(configGet(fx.a, 'branch.main.remote')).toBe('origin');
  });

  test('HEAD onto its remote: Rebase, (Interactive Rebase,) divider, Push -- Rebase comes before Push', async ({ page }) => {
    const fx = createPushDndFx();
    git(fx.a, ['switch', 'x2']);
    await openGraph(page, fx.a);
    await expandSections(page);
    await sbLocal(page, 'x2').dragTo(sbRemote(page, 'origin/x'));
    const ids = await page.getByTestId('context-menu').getByTestId('menu-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    expect(ids[0]).toBe('rebase-branch-onto-branch');
    expect(ids[ids.length - 1]).toBe('push-x-to-y');
    expect(ids).not.toContain('merge-branch-into-branch');
    await expect(page.getByTestId('menu-divider')).toHaveCount(1);
    await page.keyboard.press('Escape');
  });

  test('audit data-safety 4: a rejected drop-push shows the error only: no Force Push, origin unchanged', async ({ page }) => {
    const fx = createPushDndFx({ diverge: true });
    await openGraph(page, fx.a);
    await expandSections(page);
    await sbLocal(page, 'x2').dragTo(sbRemote(page, 'origin/x'));
    await item(page, 'push-x-to-y').click();
    await expect(page.getByTestId('toast')).toBeVisible(); // the code path ran and the refusal is shown
    await expect(page.locator('[data-testid="confirm-bar"][data-kind="force-push"]')).toHaveCount(0);
    await expect(page.getByTestId('confirm-bar')).toHaveCount(0);
    await expect(page.getByText(/force/i)).toHaveCount(0);
    expect(originRef(fx, 'refs/heads/x')).toBe(fx.originXNow);
    expect(configGet(fx.a, 'branch.x2.remote')).toBeUndefined();
    expect(tryGit(fx.a, ['merge-base', '--is-ancestor', fx.x2Sha, fx.originXNow]).status).not.toBe(0); // origin never got the local commit
  });
});

test.describe('audit security 5: the drop source comes only from in-app drag state', () => {
  test('a drop that carries only external dataTransfer text is ignored; a real drag right after still works', async ({ page }) => {
    const fx = createDndFx();
    const before = headSha(fx.a);
    await openGraph(page, fx.a);
    await expandSections(page);
    const fired = await page.evaluate(() => {
      const target = document.querySelector('[data-testid="sidebar-item"][data-kind="local"][data-name="main"]');
      if (!target) return 0;
      let n = 0;
      for (const text of ['feature/x', JSON.stringify({ name: 'feature/x', kind: 'local' })]) {
        for (const mime of ['text/plain', 'text/uri-list', 'application/json']) {
          const dt = new DataTransfer();
          dt.setData(mime, text);
          for (const type of ['dragenter', 'dragover', 'drop']) {
            target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 200, clientY: 200 }));
            n++;
          }
        }
      }
      return n;
    });
    expect(fired).toBe(18); // the events really were dispatched on the real target
    await expect(page.getByTestId('context-menu')).toHaveCount(0);
    await expect(page.getByTestId('toast')).toHaveCount(0);
    expect(headSha(fx.a)).toBe(before);
    expect(parentCount(fx.a)).toBe(1);
    // the same target does accept the real drag
    await sbLocal(page, 'feature/x').dragTo(sbLocal(page, 'main'));
    await expect(item(page, 'merge-branch-into-branch')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
