import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { createRepo, TEST_TOKEN } from './helpers/repo';

/*
 * V6b in-app terminal panel, with REAL PowerShell (Windows; the e2e server binds 127.0.0.1). Fixture repos come from createRepo (mkdtemp under
 * os.tmpdir()/gitslappin-tests); nothing is deleted. Output is checked with a MARKER built so the echo of the typed command can never match
 * (the text is split inside the command), never the exact prompt: the user's PowerShell profile may print. Only fixed commands are typed.
 *
 * data-testids the builder must provide (existing ones reused: tool-terminal, gear, preferences-view, context-menu, menu-item, confirm-bar,
 * confirm-message, confirm-ok, confirm-cancel, commit-row, commit-message):
 *  + terminal-panel              the bottom panel of the ACTIVE repo; not visible when hidden; data-minimized="true|false"
 *  + terminal-tab                one per session, text = the shell exe name ("powershell.exe" / "bash.exe"), like GitKraken, data-active="true" on the selected one
 *  + terminal-tab-close          inside a terminal-tab, title "Close Terminal {n}"
 *  + terminal-new                the New button (title "New terminal tab")
 *  + terminal-kill               Kill Terminal   + terminal-kill-all   Kill All Terminals
 *  + terminal-minimize           title "Minimize Terminal" / "Expand Terminal" (toggles)   + terminal-hide   title "Hide Terminal"
 *  + terminal-resize-handle      drag up to make the panel taller
 *  + terminal-screen             one per session (xterm mount, DOM renderer so the text is in the DOM); only the active one is visible;
 *                                data-font-size="<px it was created with>"
 *  + confirm-bar[data-kind="kill-all-terminals"]   message "Kill {n} terminals? Any running processes will be stopped." (Terminal-KillAllConfirmMessage)
 *  + preferences-nav-terminal    the "In-App Terminal" entry in Preferences   + preferences-section-terminal
 *  + pref-terminal-shell, pref-terminal-font-size (number input, saves on change/blur), pref-terminal-cursor-block / -underline / -bar
 * Terminal button: the existing tool-terminal toggles the panel (enabled when /api/ping says terminal:true). Ctrl+` toggles it too.
 * Server routes: POST /api/terminal/ticket, GET /api/terminal?ticket= (WebSocket), /api/ping gains terminal:boolean, PUT /api/prefs gains terminalFontSize.
 */

const HEADERS = { 'X-GitSlappin-Token': TEST_TOKEN };
test.describe.configure({ timeout: 90_000 });

const screen = (page: Page) => page.locator('[data-testid="terminal-screen"]:visible');
const tabs = (page: Page) => page.getByTestId('terminal-tab');

async function openRepo(page: Page, name: string, files: Record<string, string> = { 'a.txt': 'one\n' }): Promise<string> {
  const repo = createRepo(name, [{ message: 'Initial commit', files }]);
  await gotoOpenView(page);
  await openRepoByPath(page, repo);
  await expect(page.getByTestId('commit-row').first()).toBeVisible();
  return repo;
}
async function openPanel(page: Page): Promise<void> {
  await page.getByTestId('tool-terminal').click();
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect(screen(page)).toBeVisible();
}
async function run(page: Page, command: string): Promise<void> {
  await screen(page).click();
  await page.keyboard.type(command, { delay: 5 });
  await page.keyboard.press('Enter');
}
async function textOf(page: Page): Promise<string> {
  return (await screen(page).textContent()) ?? '';
}
async function pidFrom(page: Page, tag: string): Promise<number> {
  await run(page, `Write-Output ("${tag}_" + "x" + $PID)`);
  const re = new RegExp(`${tag}_x(\\d+)`);
  await expect.poll(() => textOf(page), { timeout: 30_000 }).toMatch(re);
  return Number(re.exec(await textOf(page))![1]);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.describe('terminal server surface', () => {
  test('ping says terminal is available on this server', async ({ request }) => {
    const res = await request.get('/api/ping', { headers: HEADERS });
    expect(res.ok()).toBe(true);
    expect((await res.json()).terminal).toBe(true);
  });

  test('the ticket route needs the token and returns a different ticket each time', async ({ request }) => {
    expect((await request.post('/api/terminal/ticket')).status()).toBe(403);
    expect((await request.post('/api/terminal/ticket', { headers: { 'X-GitSlappin-Token': 'wrong' } })).status()).toBe(403);
    const a = await request.post('/api/terminal/ticket', { headers: HEADERS });
    const b = await request.post('/api/terminal/ticket', { headers: HEADERS });
    expect(a.status()).toBe(200);
    const ta = (await a.json()).ticket as string;
    const tb = (await b.json()).ticket as string;
    expect(ta.length).toBeGreaterThanOrEqual(32);
    expect(ta).not.toBe(tb);
  });

  test('a ticket in the query string is no credential anywhere else, and the terminal route without an upgrade is refused', async ({ request }) => {
    const t = ((await (await request.post('/api/terminal/ticket', { headers: HEADERS })).json()) as { ticket: string }).ticket;
    for (const path of [`/api/ping?ticket=${t}`, `/api/prefs?ticket=${t}`, `/api/repos?ticket=${t}`, `/api/terminal?ticket=${t}`, `/api/terminal/x?ticket=${t}`, `/api/terminal%2F..?ticket=${t}`]) {
      expect((await request.get(path)).status(), path).toBe(403);
    }
  });

  test('in a real browser the upgrade works once per ticket: the same ticket the second time is refused', async ({ page, request }) => {
    await page.goto(`/?token=${TEST_TOKEN}`);
    const t = ((await (await request.post('/api/terminal/ticket', { headers: HEADERS })).json()) as { ticket: string }).ticket;
    const tryOpen = (ticket: string) =>
      page.evaluate(
        (tk) =>
          new Promise<string>((ok) => {
            const s = new WebSocket(`ws://${location.host}/api/terminal?ticket=${tk}`);
            s.onopen = () => {
              s.close();
              ok('open');
            };
            s.onerror = () => ok('refused');
          }),
        ticket,
      );
    expect(await tryOpen(t)).toBe('open'); // same origin, valid ticket
    expect(await tryOpen(t)).toBe('refused'); // used up
    expect(await tryOpen('not-a-ticket')).toBe('refused');
  });
});

test.describe('terminal panel', () => {
  test('the Terminal button and Ctrl+` toggle the panel, and a marker typed in the real shell shows up', async ({ page }) => {
    await openRepo(page, 'term-toggle');
    await expect(page.getByTestId('terminal-panel')).not.toBeVisible();
    await expect(page.getByTestId('tool-terminal')).toBeEnabled();
    await openPanel(page);
    await expect(tabs(page)).toHaveCount(1);
    await expect(tabs(page).first()).toHaveText(/powershell.exe/);
    await run(page, 'Write-Output ("MARK_" + "7431")');
    await expect(screen(page)).toContainText('MARK_7431', { timeout: 30_000 });

    await page.getByTestId('tool-terminal').click(); // hides
    await expect(page.getByTestId('terminal-panel')).not.toBeVisible();
    await page.keyboard.press('Control+Backquote'); // shows again; Hide kept the session
    await expect(page.getByTestId('terminal-panel')).toBeVisible();
    await expect(screen(page)).toContainText('MARK_7431');
    await expect(tabs(page)).toHaveCount(1);

    await page.keyboard.press('Control+Backquote'); // Ctrl+` also works while the terminal has focus
    await expect(page.getByTestId('terminal-panel')).not.toBeVisible();
    await page.keyboard.press('Control+Backquote');
    await screen(page).click();
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByTestId('terminal-panel')).not.toBeVisible();
  });

  test('the Hide button hides the panel but keeps the session; Minimize and Expand swap their title', async ({ page }) => {
    await openRepo(page, 'term-hide');
    await openPanel(page);
    await run(page, 'Write-Output ("KEEP_" + "5512")');
    await expect(screen(page)).toContainText('KEEP_5512', { timeout: 30_000 });
    const min = page.getByTestId('terminal-minimize');
    await expect(min).toHaveAttribute('title', 'Minimize Terminal');
    await min.click();
    await expect(page.getByTestId('terminal-panel')).toHaveAttribute('data-minimized', 'true');
    await expect(min).toHaveAttribute('title', 'Expand Terminal');
    await min.click();
    await expect(page.getByTestId('terminal-panel')).toHaveAttribute('data-minimized', 'false');
    await page.getByTestId('terminal-hide').click();
    await expect(page.getByTestId('terminal-panel')).not.toBeVisible();
    await page.getByTestId('tool-terminal').click();
    await expect(screen(page)).toContainText('KEEP_5512');
  });

  test('showing the panel again after Hide expands it even if it was minimized, and it sits under the graph only', async ({ page }) => {
    await openRepo(page, 'term-reshow');
    await openPanel(page);
    const panel = page.getByTestId('terminal-panel');
    const box = (await panel.boundingBox())!;
    const side = (await page.getByTestId('left-panel').boundingBox().catch(() => null)) ?? null;
    if (side) expect(box.x).toBeGreaterThanOrEqual(side.x + side.width - 1);
    expect(box.x + box.width).toBeLessThan((await page.viewportSize())!.width - 100); // the details panel on the right stays full height
    await page.getByTestId('terminal-minimize').click();
    await expect(panel).toHaveAttribute('data-minimized', 'true');
    await page.getByTestId('terminal-hide').click();
    await expect(panel).not.toBeVisible();
    await page.getByTestId('tool-terminal').click();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-minimized', 'false');
    await expect(screen(page)).toBeVisible();
  });

  test('dragging the resize handle up makes the panel taller', async ({ page }) => {
    await openRepo(page, 'term-resize');
    await openPanel(page);
    const panel = page.getByTestId('terminal-panel');
    const before = (await panel.boundingBox())!;
    const handle = (await page.getByTestId('terminal-resize-handle').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 120, { steps: 6 });
    await page.mouse.up();
    const after = (await panel.boundingBox())!;
    expect(after.height).toBeGreaterThan(before.height + 60);
  });

  test('a commit typed in the terminal shows in the graph with no click', async ({ page }) => {
    await openRepo(page, 'term-commit');
    await openPanel(page);
    await run(page, 'git commit --allow-empty -q -m "Typed in terminal"');
    const row = page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: 'Typed in terminal' }) });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
  });

  test('the shell has no GitSlappin token in its environment, and starts in the repo folder', async ({ page }) => {
    const repo = await openRepo(page, 'term-env');
    await openPanel(page);
    await run(page, 'Write-Output ("TOK_" + [string]($null -eq $env:GITSLAPPIN_TOKEN))');
    await expect(screen(page)).toContainText('TOK_True', { timeout: 30_000 });
    expect(await textOf(page)).not.toContain(TEST_TOKEN);
    await run(page, 'Write-Output ("HAS_" + [string](Test-Path .\\README.md))');
    await expect(screen(page)).toContainText('HAS_False', { timeout: 30_000 }); // fixture files are a.txt, not README.md
    await run(page, 'Write-Output ("HAS2_" + [string](Test-Path .\\a.txt))');
    await expect(screen(page)).toContainText('HAS2_True', { timeout: 30_000 });
    expect(repo.length).toBeGreaterThan(0); // fixture folder name is only used above through the shell's cwd
  });

  test('S and U typed in the terminal are text for the shell and stage nothing in the repo', async ({ page }) => {
    const repo = await openRepo(page, 'term-su');
    writeFileSync(join(repo, 'a.txt'), 'changed\n'); // a modified file, so a stage-all shortcut would have something to stage
    await openPanel(page);
    await screen(page).click();
    await page.keyboard.press('s');
    await page.keyboard.press('u');
    await page.keyboard.type(';Write-Output ("SU_" + "done")', { delay: 5 });
    await page.keyboard.press('Enter');
    await expect(screen(page)).toContainText('SU_done', { timeout: 30_000 }); // the typing really reached the shell
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    expect(staged).toBe('');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    expect(status).toContain(' M a.txt');
  });

  test('right-click shows the terminal menu, and Close Terminal removes the tab', async ({ page }) => {
    await openRepo(page, 'term-menu');
    await openPanel(page);
    await run(page, 'Write-Output ("MENU_" + "ok")');
    await expect(screen(page)).toContainText('MENU_ok', { timeout: 30_000 });
    await screen(page).click({ button: 'right' });
    const menu = page.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    for (const label of ['Copy', 'Paste', 'Select All', 'Clear', 'Close Terminal']) {
      await expect(menu.getByTestId('menu-item').filter({ hasText: label })).toHaveCount(1);
    }
    await menu.getByTestId('menu-item').filter({ hasText: 'Close Terminal' }).click();
    await expect(tabs(page)).toHaveCount(0);
  });

  test('New adds Terminal 2, each tab has its own shell, and closing a tab keeps the other', async ({ page }) => {
    await openRepo(page, 'term-tabs');
    await openPanel(page);
    await run(page, 'Write-Output ("ONE_" + "111")');
    await expect(screen(page)).toContainText('ONE_111', { timeout: 30_000 });
    await page.getByTestId('terminal-new').click();
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(1)).toHaveText(/powershell.exe/);
    await expect(tabs(page).nth(1)).toHaveAttribute('data-active', 'true');
    await run(page, 'Write-Output ("TWO_" + "222")');
    await expect(screen(page)).toContainText('TWO_222', { timeout: 30_000 });
    expect(await textOf(page)).not.toContain('ONE_111'); // its own shell, its own screen
    await tabs(page).nth(0).click();
    await expect(screen(page)).toContainText('ONE_111');
    await tabs(page).nth(0).getByTestId('terminal-tab-close').click();
    await expect(tabs(page)).toHaveCount(1);
    await expect(screen(page)).toContainText('TWO_222');
  });

  test('Kill All asks first (cancel keeps both), then really ends both shell processes', async ({ page }) => {
    await openRepo(page, 'term-killall');
    await openPanel(page);
    const p1 = await pidFrom(page, 'PIDA');
    await page.getByTestId('terminal-new').click();
    await expect(tabs(page)).toHaveCount(2);
    const p2 = await pidFrom(page, 'PIDB');
    expect(alive(p1)).toBe(true);
    expect(alive(p2)).toBe(true);

    await page.getByTestId('terminal-kill-all').click();
    const bar = page.locator('[data-testid="confirm-bar"][data-kind="kill-all-terminals"]');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('confirm-message')).toHaveText('Kill 2 terminals? Any running processes will be stopped.');
    await page.getByTestId('confirm-cancel').click();
    await expect(bar).toHaveCount(0);
    await expect(tabs(page)).toHaveCount(2);
    expect(alive(p1)).toBe(true);
    expect(alive(p2)).toBe(true);

    await page.getByTestId('terminal-kill-all').click();
    await page.getByTestId('confirm-ok').click();
    await expect(tabs(page)).toHaveCount(0);
    await expect.poll(() => alive(p1) || alive(p2), { timeout: 20_000 }).toBe(false);
  });
});

test.describe('terminal preferences', () => {
  test('the In-App Terminal page shows the three kept settings and none of the cut ones', async ({ page }) => {
    await openRepo(page, 'term-prefs-ui');
    await page.getByTestId('gear').click();
    await expect(page.getByTestId('preferences-view')).toBeVisible();
    await page.getByTestId('preferences-nav-terminal').click();
    const section = page.getByTestId('preferences-section-terminal');
    await expect(section).toBeVisible();
    for (const text of ['In-App Terminal', 'Default In-App Terminal', 'Font Size', 'Cursor Style', 'PowerShell']) await expect(section).toContainText(text);
    for (const text of ['Dim terminal when unfocused', 'Autocomplete']) await expect(section).not.toContainText(text);
    await expect(page.getByTestId('pref-terminal-shell')).toBeVisible();
    await expect(page.getByTestId('pref-terminal-font-size')).toHaveValue('13');
    for (const c of ['block', 'underline', 'bar']) await expect(page.getByTestId(`pref-terminal-cursor-${c}`)).toBeVisible();
  });

  test('a Font Size change is saved and applies to a NEW tab only', async ({ page, request }) => {
    await request.put('/api/prefs', { headers: HEADERS, data: { terminalFontSize: 13 } });
    try {
      await openRepo(page, 'term-prefs-font');
      await openPanel(page);
      await expect(screen(page)).toHaveAttribute('data-font-size', '13');

      await page.getByTestId('gear').click();
      await page.getByTestId('preferences-nav-terminal').click();
      const input = page.getByTestId('pref-terminal-font-size');
      await input.fill('18');
      await input.blur();
      await expect.poll(async () => ((await (await request.get('/api/prefs', { headers: HEADERS })).json()) as { terminalFontSize: number }).terminalFontSize).toBe(18);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('preferences-view')).toHaveCount(0);

      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await page.getByTestId('terminal-new').click();
      await expect(tabs(page)).toHaveCount(2);
      await expect(screen(page)).toHaveAttribute('data-font-size', '18');
      await tabs(page).nth(0).click();
      await expect(screen(page)).toHaveAttribute('data-font-size', '13'); // the old tab keeps its size
    } finally {
      await request.put('/api/prefs', { headers: HEADERS, data: { terminalFontSize: 13 } });
    }
  });

  test('the prefs API rejects a font size outside 10..24 and a shell that is a path', async ({ request }) => {
    for (const data of [{ terminalFontSize: 9 }, { terminalFontSize: 25 }, { terminalFontSize: 13.5 }, { terminalShell: 'C:\\Windows\\System32\\cmd.exe' }, { terminalCursor: 'line' }]) {
      expect((await request.put('/api/prefs', { headers: HEADERS, data })).status(), JSON.stringify(data)).toBe(400);
    }
  });
});
