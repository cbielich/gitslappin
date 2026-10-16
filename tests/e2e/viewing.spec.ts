import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { TEST_TOKEN } from './helpers/repo';
import { createViewingRepo } from './helpers/viewingFixtures';

/*
 * V5 (Compare commits, File History / Blame, Hide / Solo). Graph multi-select (shift = range of loaded rows, ctrl = toggle) is built in V4 and assumed here.
 * Fixture: helpers/viewingFixtures.ts (rows newest first: Extra work, Final polish, Rename and prune, Debounce search input, Add search box, Side work, Initial commit).
 * Existing test ids used: repo-view, commit-row, commit-message, ref-pill[data-name], sidebar-item[data-kind][data-name], sidebar-toggle-<id>, sidebar-count-<id>, viewing-count,
 *   context-menu, menu-item, file-row[data-path][data-status], diff-view, diff-path, diff-close, commit-details.
 * NEW test ids the builder must implement (+):
 *  + compare-details          root of the multi-select panel (replaces commit-details for a multi selection)
 *  + compare-header           text "<N> commits selected"
 *  + compare-title            the mode title (Viewing diff between 2 commits / of N commits / between a commit and the WIP / ... / explanation)
 *  + compare-card             one per commit (data-sha): summary, "MM/DD/YYYY @ h:mm AM by Name", short sha;  + compare-more  the "and N more" line after 200 cards
 *    (the file list inside compare-details reuses file-row[data-path][data-status]; clicking a file opens diff-view)
 *  + diff-history-button      DiffView header button "History";  + diff-blame-button  DiffView header button "Blame"  (both absent inside file-history-view)
 *  + file-history-view        replaces the diff pane;  file-history-title ("File History: <path>"), file-history-encoding ("UTF-8"), file-history-close (the X)
 *  + file-history-entry       one per list row (data-sha, data-status, aria-selected): summary, "MM/DD/YYYY by Name", short sha
 *  + file-history-added       the "ADDED <path>" marker row when the last entry is an A;  file-history-end  "End of History" (when hasMore is false)
 *  + file-history-mode-file ("File View"), file-history-mode-diff ("Diff View")   (aria-pressed)
 *  + file-history-blame-toggle  label "Blame", title "Show blame details" (aria-pressed)
 *  + file-history-file-view   read-only file pane;  blame-gutter  the gutter;  blame-run (data-sha) one per run of lines;  blame-summary  the summary text shown on the first
 *    line of a run ONLY while blame is on;  blame-avatar always
 *  + sidebar-eye              hover button on local / remote / tag rows (title "Hide in the graph" / "Show in the graph"); not present on the checked-out branch;
 *                             sidebar-item gets data-hidden="true" when hidden; the eye stays visible on a hidden row
 *  + viewing-label            text "Viewing" or "Soloing";  viewing-count  (existing) becomes "<visible>/<total>" only while something is hidden, counts local + remote + tags (no stashes)
 *  + viewing-show-all         button "Show All" (only while something is hidden);  viewing-unsolo  button "Stop Soloing" (only while soloing)
 *  sidebar-count-<id> shows "<visible>/<total>" only for a section with something hidden.
 * Menus (text from en-us.json): commit row: "Compare commit against working directory"; local/remote/tag row: "Solo this branch" / "Stop soloing this branch";
 *   section head (right-click sidebar-toggle-<id>): "Hide all local branches"/"Show all local branches", "Hide all remotes"/"Show all remotes", "Hide all tags"/"Show all tags", "Hide all stashes"/"Show all stashes".
 * UNVERIFIED: History opens with File View selected (screen 30 shows plain code); the Blame button opens File View with blame on (design); the compare-header count while WIP is
 *   part of the selection is not asserted; the page keeps the open tab after page.reload() (tabs are stored by the server).
 * NOT COVERED here: the 200-card cap with its "and N more" line (invented wording; needs a 250-row selection) and the one-in-flight / 120 s timeout of /compare, /file-history, /blame.
 */

const headers = { 'X-GitSlappin-Token': TEST_TOKEN };

const L = {
  pair: 'Viewing diff between 2 commits',
  nCommits: (n: number) => `Viewing diff of ${n} commits`,
  wip: 'Viewing diff between a commit and the WIP',
  explain: 'A combined diff is not shown for this selection. Select a contiguous range of commits, or one or two items, to see their changes.',
  compareMenu: 'Compare commit against working directory',
  hideTags: 'Hide all tags',
  showTags: 'Show all tags',
  hideLocal: 'Hide all local branches',
  solo: 'Solo this branch',
  stopSolo: 'Stop soloing this branch',
} as const;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const menuItem = (page: Page, text: string) => page.getByTestId('context-menu').getByTestId('menu-item').filter({ hasText: new RegExp(`^\\s*${esc(text)}\\s*$`) });
const row = (page: Page, subject: string) => page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: new RegExp(`^${esc(subject)}$`) }) });
const sbLocal = (page: Page, name: string) => page.locator(`[data-testid="sidebar-item"][data-kind="local"][data-name="${name}"]`);
const pill = (page: Page, name: string) => page.locator(`[data-testid="ref-pill"][data-name="${name}"]`);

async function openGraph(page: Page, repo: string): Promise<void> {
  const res = await page.request.put('/api/prefs', { headers, data: { autoFetchMinutes: 0 } }); // no background fetch changes the fixture
  expect(res.status()).toBe(200);
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
async function plain(page: Page, subject: string): Promise<void> {
  await row(page, subject).click();
}
async function shift(page: Page, subject: string): Promise<void> {
  await row(page, subject).click({ modifiers: ['Shift'] });
}
async function ctrl(page: Page, subject: string): Promise<void> {
  await row(page, subject).click({ modifiers: ['Control'] });
}
async function openFileHistoryDiff(page: Page, which: 'history' | 'blame'): Promise<void> {
  await plain(page, 'Debounce search input');
  await page.locator('[data-testid="file-row"][data-path="src/search.js"]').click();
  await expect(page.getByTestId('diff-view')).toBeVisible();
  await page.getByTestId(which === 'history' ? 'diff-history-button' : 'diff-blame-button').click();
  await expect(page.getByTestId('file-history-view')).toBeVisible();
}

// ---------------------------------------------------------------------------------------------------------------------
test.describe('Compare commits (multi-select)', () => {
  test('shift-click two rows: "2 commits selected" / "Viewing diff between 2 commits", a card per commit, the changed file opens a diff', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await plain(page, 'Debounce search input');
    await shift(page, 'Add search box');
    const d = page.getByTestId('compare-details');
    await expect(d).toBeVisible();
    await expect(page.getByTestId('commit-details')).toHaveCount(0);
    await expect(page.getByTestId('compare-header')).toHaveText('2 commits selected');
    await expect(page.getByTestId('compare-title')).toHaveText(L.pair);
    await expect(d.getByTestId('compare-card')).toHaveCount(2);
    const first = d.getByTestId('compare-card').first();
    await expect(first).toContainText('Debounce search input');
    await expect(first).toContainText(/\d{2}\/\d{2}\/\d{4} @ \d{1,2}:\d{2} (AM|PM) by Test Author/);
    await expect(first).toContainText(/[0-9a-f]{6,7}/);
    await expect(d.getByTestId('compare-card').nth(1)).toContainText('Add search box');
    // the diff is between the two commits: src/search.js is modified (one added line); app.js and README are not in it
    await expect(d.getByTestId('file-row')).toHaveCount(1);
    await expect(d.locator('[data-testid="file-row"][data-path="src/search.js"][data-status="M"]')).toBeVisible();
    await d.locator('[data-testid="file-row"][data-path="src/search.js"]').click();
    await expect(page.getByTestId('diff-view')).toBeVisible();
    await expect(page.getByTestId('diff-path')).toContainText('src/search.js');
    await expect(page.getByTestId('diff-view')).toContainText('// debounce');
  });

  test('ctrl-click a pair: Modified, Added and Deleted files are all listed', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await plain(page, 'Rename and prune');
    await ctrl(page, 'Debounce search input');
    const d = page.getByTestId('compare-details');
    await expect(page.getByTestId('compare-title')).toHaveText(L.pair);
    await expect(d.locator('[data-testid="file-row"][data-path="README.md"][data-status="M"]')).toBeVisible();
    await expect(d.locator('[data-testid="file-row"][data-path="docs/notes.md"][data-status="A"]')).toBeVisible();
    await expect(d.locator('[data-testid="file-row"][data-path="src/app.js"][data-status="D"]')).toBeVisible();
    await expect(d.getByTestId('file-row')).toHaveCount(3);
  });

  test('a chain of 3 commits shows "Viewing diff of 3 commits" with the range diff', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await plain(page, 'Final polish');
    await shift(page, 'Debounce search input'); // Final polish, Rename and prune, Debounce search input
    await expect(page.getByTestId('compare-header')).toHaveText('3 commits selected');
    await expect(page.getByTestId('compare-title')).toHaveText(L.nCommits(3));
    const d = page.getByTestId('compare-details');
    await expect(d.getByTestId('compare-card')).toHaveCount(3);
    // from the parent of the oldest (Add search box) to Final polish: search.js M, app.js D, notes.md A, README M
    await expect(d.locator('[data-testid="file-row"][data-path="src/search.js"][data-status="M"]')).toBeVisible();
    await expect(d.locator('[data-testid="file-row"][data-path="src/app.js"][data-status="D"]')).toBeVisible();
    await expect(d.locator('[data-testid="file-row"][data-path="docs/notes.md"][data-status="A"]')).toBeVisible();
  });

  test('3 commits that are not one chain show the explanation and no file list', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await plain(page, 'Rename and prune');
    await ctrl(page, 'Side work');
    await ctrl(page, 'Add search box');
    await expect(page.getByTestId('compare-header')).toHaveText('3 commits selected');
    await expect(page.getByTestId('compare-title')).toHaveText(L.explain);
    await expect(page.getByTestId('compare-details').getByTestId('file-row')).toHaveCount(0);
  });

  test('"Compare commit against working directory": commit vs the WIP, tracked changes only', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await row(page, 'Debounce search input').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await menuItem(page, L.compareMenu).click();
    const d = page.getByTestId('compare-details');
    await expect(page.getByTestId('compare-title')).toHaveText(L.wip);
    // working copy vs Debounce search input: search.js edited in the folder, README.md / notes.md / app.js differ from that older commit; the untracked file is not listed
    await expect(d.locator('[data-testid="file-row"][data-path="src/search.js"][data-status="M"]')).toBeVisible();
    await expect(d.locator('[data-testid="file-row"][data-path="docs/notes.md"][data-status="A"]')).toBeVisible();
    await expect(d.locator('[data-testid="file-row"][data-path="untracked-note.txt"]')).toHaveCount(0);
    await d.locator('[data-testid="file-row"][data-path="src/search.js"]').click();
    await expect(page.getByTestId('diff-view')).toBeVisible();
    await expect(page.getByTestId('diff-view')).toContainText('// working copy edit');
  });

  test('a single commit still shows the normal commit details (no compare panel)', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await plain(page, 'Add search box');
    await expect(page.getByTestId('commit-details')).toBeVisible();
    await expect(page.getByTestId('compare-details')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('File History and Blame', () => {
  test('History: list with the added marker, End of History, and the Diff View / File View toggles', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await openFileHistoryDiff(page, 'history');
    const v = page.getByTestId('file-history-view');
    await expect(page.getByTestId('file-history-title')).toHaveText('File History: src/search.js');
    await expect(page.getByTestId('file-history-encoding')).toHaveText('UTF-8');
    // opens at the commit that was selected (Debounce search input): its history is that commit and Add search box
    await expect(v.getByTestId('file-history-entry')).toHaveCount(2);
    const first = v.getByTestId('file-history-entry').first();
    await expect(first).toContainText('Debounce search input');
    await expect(first).toContainText(/\d{2}\/\d{2}\/\d{4} by Test Author/);
    await expect(first).toContainText(/[0-9a-f]{6,7}/);
    await expect(first).toHaveAttribute('data-status', 'M');
    await expect(v.getByTestId('file-history-entry').nth(1)).toContainText('Add search box');
    await expect(v.getByTestId('file-history-entry').nth(1)).toHaveAttribute('data-status', 'A');
    await expect(v.getByTestId('file-history-added')).toContainText('ADDED');
    await expect(v.getByTestId('file-history-added')).toContainText('src/search.js');
    await expect(v.getByTestId('file-history-end')).toHaveText('End of History');
    // File View is the default (screen 30): the file text, no diff pane, no blame text
    await expect(page.getByTestId('file-history-mode-file')).toHaveAttribute('aria-pressed', 'true');
    await expect(v.getByTestId('file-history-file-view')).toContainText('export function search');
    await expect(v.getByTestId('blame-summary')).toHaveCount(0);
    // Diff View: the existing DiffView, without its own History / Blame buttons
    await page.getByTestId('file-history-mode-diff').click();
    await expect(page.getByTestId('file-history-mode-diff')).toHaveAttribute('aria-pressed', 'true');
    await expect(v.getByTestId('diff-view')).toBeVisible();
    await expect(v.getByTestId('diff-history-button')).toHaveCount(0);
    await expect(v.getByTestId('diff-blame-button')).toHaveCount(0);
    await page.getByTestId('file-history-mode-file').click();
    await expect(v.getByTestId('file-history-file-view')).toBeVisible();
    // Blame toggle shows author summaries beside the lines and turns off again
    const toggle = page.getByTestId('file-history-blame-toggle');
    await expect(toggle).toHaveText('Blame');
    await expect(toggle).toHaveAttribute('title', 'Show blame details');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(v.getByTestId('blame-summary').first()).toBeVisible();
    await toggle.click();
    await expect(v.getByTestId('blame-summary')).toHaveCount(0);
    // the X goes back to the diff pane
    await page.getByTestId('file-history-close').click();
    await expect(page.getByTestId('file-history-view')).toHaveCount(0);
    await expect(page.getByTestId('diff-view')).toBeVisible();
  });

  test('the Blame button opens File History in File View with blame already on: each run of lines names its commit', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await openFileHistoryDiff(page, 'blame');
    const v = page.getByTestId('file-history-view');
    await expect(page.getByTestId('file-history-blame-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('file-history-mode-file')).toHaveAttribute('aria-pressed', 'true');
    // line 1 comes from "Add search box", line 2 from "Debounce search input"
    await expect(v.getByTestId('blame-run')).toHaveCount(2);
    await expect(v.getByTestId('blame-run').nth(0)).toContainText('Add search box');
    await expect(v.getByTestId('blame-run').nth(1)).toContainText('Debounce search input');
    await expect(v.getByTestId('blame-run').nth(0)).toHaveAttribute('data-sha', /^[0-9a-f]{40}$/);
    await expect(v.getByTestId('blame-avatar').first()).toBeVisible();
  });

  test('a file history error shows the exact error text and leaves the app usable', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await page.route('**/api/repos/*/file-history*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
    await plain(page, 'Debounce search input');
    await page.locator('[data-testid="file-row"][data-path="src/search.js"]').click();
    await page.getByTestId('diff-history-button').click();
    await expect(page.getByText('Failed to generate file history')).toBeVisible();
    await expect(page.getByTestId('repo-view')).toBeVisible();
  });

  test('review fix 4: a 404 from file-history shows a clear message, not the generic failure', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await page.route('**/api/repos/*/file-history*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }) }));
    await plain(page, 'Debounce search input');
    await page.locator('[data-testid="file-row"][data-path="src/search.js"]').click();
    await page.getByTestId('diff-history-button').click();
    await expect(page.getByText('No history for this file')).toBeVisible();
    await expect(page.getByText('Failed to generate file history')).toHaveCount(0);
  });

  test('review fix 4: a deleted (D) entry hides the Blame toggle and shows no file text or error', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    const sha = 'a'.repeat(40);
    const entry = { sha, authorName: 'A', authorEmail: 'a@example.com', authorDate: '2026-01-01T10:00:00+00:00', summary: 'Remove it', status: 'D', path: 'src/search.js' };
    await page.route('**/api/repos/*/file-history*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [entry], nextSkip: 1, hasMore: false }) }));
    let blameCalls = 0;
    await page.route('**/api/repos/*/blame*', (r) => {
      blameCalls++;
      return r.abort();
    });
    await plain(page, 'Debounce search input');
    await page.locator('[data-testid="file-row"][data-path="src/search.js"]').click();
    await page.getByTestId('diff-history-button').click();
    await expect(page.getByTestId('file-history-deleted')).toBeVisible();
    await expect(page.getByTestId('file-history-blame-toggle')).toHaveCount(0);
    await expect(page.getByText('Failed to resolve blame')).toHaveCount(0);
    expect(blameCalls).toBe(0);
  });

  test('a blame error shows "Failed to resolve blame"', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await page.route('**/api/repos/*/blame*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
    await plain(page, 'Debounce search input');
    await page.locator('[data-testid="file-row"][data-path="src/search.js"]').click();
    await page.getByTestId('diff-blame-button').click();
    await expect(page.getByText('Failed to resolve blame')).toBeVisible();
    await expect(page.getByTestId('repo-view')).toBeVisible();
  });

  test('audit fix 4: turning blame on and off in File View does not call /blame a second time', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    let blameCalls = 0;
    page.on('request', (r) => {
      if (/\/api\/repos\/[^/]+\/blame/.test(r.url())) blameCalls++;
    });
    await openFileHistoryDiff(page, 'blame');
    await expect(page.getByTestId('blame-summary').first()).toBeVisible();
    expect(blameCalls).toBe(1);
    const toggle = page.getByTestId('file-history-blame-toggle');
    await toggle.click();
    await expect(page.getByTestId('blame-summary')).toHaveCount(0);
    await toggle.click();
    await expect(page.getByTestId('blame-summary').first()).toBeVisible();
    expect(blameCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('Hide / Solo', () => {
  test('eye on hover hides a local branch: "Viewing 4/5", section "2/3", its commit leaves the graph, the row is dimmed, Show All restores it', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await expandSections(page, ['local']);
    await expect(page.getByTestId('viewing-count')).toHaveText('5');
    await expect(page.getByTestId('viewing-show-all')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-count-local')).toHaveText('3');
    await expect(row(page, 'Side work')).toHaveCount(1);
    const item = sbLocal(page, 'feature/side');
    await item.hover();
    const eye = item.getByTestId('sidebar-eye');
    await expect(eye).toHaveAttribute('title', 'Hide in the graph');
    await eye.click();
    await expect(page.getByTestId('viewing-label')).toHaveText('Viewing');
    await expect(page.getByTestId('viewing-count')).toHaveText('4/5');
    await expect(page.getByTestId('sidebar-count-local')).toHaveText('2/3');
    await expect(row(page, 'Side work')).toHaveCount(0);
    await expect(pill(page, 'feature/side')).toHaveCount(0);
    await expect(row(page, 'Initial commit')).toHaveCount(1); // shared commits stay
    await page.mouse.move(0, 0);
    await expect(item).toHaveAttribute('data-hidden', 'true');
    await expect(item.getByTestId('sidebar-eye')).toBeVisible(); // a hidden row keeps its icon without hover
    await expect(item.getByTestId('sidebar-eye')).toHaveAttribute('title', 'Show in the graph');
    await page.getByTestId('viewing-show-all').click();
    await expect(page.getByTestId('viewing-count')).toHaveText('5');
    await expect(page.getByTestId('sidebar-count-local')).toHaveText('3');
    await expect(row(page, 'Side work')).toHaveCount(1);
    await expect(item).not.toHaveAttribute('data-hidden', 'true');
  });

  test('the eye on a hidden row shows the branch again; the checked-out branch has no eye', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await expandSections(page, ['local']);
    const item = sbLocal(page, 'feature/extra');
    await item.hover();
    await item.getByTestId('sidebar-eye').click();
    await expect(row(page, 'Extra work')).toHaveCount(0);
    await item.getByTestId('sidebar-eye').click();
    await expect(row(page, 'Extra work')).toHaveCount(1);
    await expect(page.getByTestId('viewing-count')).toHaveText('5');
    const main = sbLocal(page, 'main');
    await main.hover();
    await expect(main.getByTestId('sidebar-eye')).toHaveCount(0);
  });

  test('hidden state is saved on the server per repo: it survives a page reload', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await expandSections(page, ['local']);
    const item = sbLocal(page, 'feature/side');
    await item.hover();
    await item.getByTestId('sidebar-eye').click();
    await expect(row(page, 'Side work')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('commit-row').first()).toBeVisible();
    await expect(row(page, 'Side work')).toHaveCount(0);
    await expect(page.getByTestId('viewing-count')).toHaveText('4/5');
    await expandSections(page, ['local']);
    await expect(sbLocal(page, 'feature/side')).toHaveAttribute('data-hidden', 'true');
  });

  test('section menu "Hide all tags" hides every tag label and "Show all tags" brings them back', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await expect(pill(page, 'v1.0').first()).toBeVisible();
    await page.getByTestId('sidebar-toggle-tags').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await menuItem(page, L.hideTags).click();
    await expect(pill(page, 'v1.0')).toHaveCount(0);
    await expect(page.getByTestId('viewing-count')).toHaveText('4/5');
    await expect(row(page, 'Add search box')).toHaveCount(1); // the commit is still reachable from main
    await page.getByTestId('sidebar-toggle-tags').click({ button: 'right' });
    await menuItem(page, L.showTags).click();
    await expect(pill(page, 'v1.0').first()).toBeVisible();
    await expect(page.getByTestId('viewing-count')).toHaveText('5');
  });

  test('section menu "Hide all local branches" hides every local branch except the checked-out one', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await page.getByTestId('sidebar-toggle-local').click({ button: 'right' });
    await menuItem(page, L.hideLocal).click();
    await expect(row(page, 'Side work')).toHaveCount(0);
    await expect(row(page, 'Extra work')).toHaveCount(0);
    await expect(row(page, 'Final polish')).toHaveCount(1);
    await expect(pill(page, 'main').first()).toBeVisible();
    await expect(page.getByTestId('viewing-count')).toHaveText('3/5');
    await expect(page.getByTestId('sidebar-count-local')).toHaveText('1/3');
  });

  test('Solo shows "Soloing", keeps only that branch and HEAD, and "Stop Soloing" restores everything', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await expandSections(page, ['local']);
    await sbLocal(page, 'feature/side').click({ button: 'right' });
    await menuItem(page, L.solo).click();
    await expect(page.getByTestId('viewing-label')).toHaveText('Soloing');
    await expect(row(page, 'Side work')).toHaveCount(1);
    await expect(row(page, 'Final polish')).toHaveCount(1); // HEAD is always shown
    await expect(row(page, 'Extra work')).toHaveCount(0);
    await expect(page.getByTestId('viewing-unsolo')).toHaveText('Stop Soloing');
    await page.getByTestId('viewing-unsolo').click();
    await expect(page.getByTestId('viewing-label')).toHaveText('Viewing');
    await expect(row(page, 'Extra work')).toHaveCount(1);
    await expect(page.getByTestId('viewing-unsolo')).toHaveCount(0);
  });

  test('the soloed row offers "Stop soloing this branch"', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await expandSections(page, ['local']);
    await sbLocal(page, 'feature/side').click({ button: 'right' });
    await menuItem(page, L.solo).click();
    await expect(page.getByTestId('viewing-label')).toHaveText('Soloing');
    await sbLocal(page, 'feature/side').click({ button: 'right' });
    await expect(menuItem(page, L.solo)).toHaveCount(0);
    await menuItem(page, L.stopSolo).click();
    await expect(page.getByTestId('viewing-label')).toHaveText('Viewing');
    await expect(row(page, 'Extra work')).toHaveCount(1);
  });

  test('review fix 1: solo on a hidden branch shows it (solo wins and clears the hide)', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await expandSections(page, ['local']);
    const item = sbLocal(page, 'feature/side');
    await item.hover();
    await item.getByTestId('sidebar-eye').click();
    await expect(row(page, 'Side work')).toHaveCount(0);
    await item.click({ button: 'right' });
    await menuItem(page, L.solo).click();
    await expect(page.getByTestId('viewing-label')).toHaveText('Soloing');
    await expect(row(page, 'Side work')).toHaveCount(1);
    await expect(sbLocal(page, 'feature/side')).not.toHaveAttribute('data-hidden', 'true');
  });

  test('review fix 3: rapid toggles are saved one after another and the graph ends in the last state', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await expandSections(page, ['local']);
    let inFlight = 0;
    let overlap = false;
    await page.route('**/api/repos/*/visibility', async (r) => {
      if (r.request().method() !== 'PUT') return r.continue();
      inFlight++;
      if (inFlight > 1) overlap = true;
      await new Promise((res) => setTimeout(res, 150));
      await r.continue();
      inFlight--;
    });
    for (const n of ['feature/side', 'feature/extra']) {
      const it = sbLocal(page, n);
      await it.hover();
      await it.getByTestId('sidebar-eye').click();
    }
    await expect(row(page, 'Side work')).toHaveCount(0);
    await expect(row(page, 'Extra work')).toHaveCount(0);
    await expect(page.getByTestId('viewing-count')).toHaveText('3/5');
    expect(overlap).toBe(false);
  });

  test('a toggle is saved through PUT /visibility', async ({ page }) => {
    await openGraph(page, createViewingRepo());
    await expandSections(page, ['local']);
    const calls: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/repos\/[^/]+\/visibility/.test(r.url())) calls.push(`${r.method()} visibility`);
    });
    const item = sbLocal(page, 'feature/extra');
    await item.hover();
    await item.getByTestId('sidebar-eye').click();
    await expect(row(page, 'Extra work')).toHaveCount(0);
    expect(calls).toContain('PUT visibility'); // the toggle really went through the visibility route
  });
});
