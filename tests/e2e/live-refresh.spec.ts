import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { gotoOpenView, openRepoByPath } from './helpers/app';
import { createRepo } from './helpers/repo';

// Live auto-refresh: the screen follows changes made outside GitSlappin with no click and no reload.
// Writes only inside throwaway fixture repos made by createRepo (mkdtemp under os.tmpdir()/gitslappin-tests).

function cliCommit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Cli', GIT_AUTHOR_EMAIL: 'cli@example.com', GIT_COMMITTER_NAME: 'Cli', GIT_COMMITTER_EMAIL: 'cli@example.com' };
  execFileSync('git', ['add', file], { cwd: dir, env, windowsHide: true });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, env, windowsHide: true });
}

test.describe('live refresh', () => {
  test('the WIP count updates with no click after a file is written outside the app', async ({ page }) => {
    const repo = createRepo('live-wip', [{ message: 'Initial commit', files: { 'a.txt': 'one\n', 'b.txt': 'one\n' } }]);
    await gotoOpenView(page);
    await openRepoByPath(page, repo);
    await expect(page.getByTestId('commit-row').first()).toBeVisible();
    await expect(page.getByTestId('wip-count-modified')).toHaveCount(0); // clean tree first

    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    await expect(page.getByTestId('wip-count-modified')).toContainText('1', { timeout: 10_000 });

    writeFileSync(join(repo, 'b.txt'), 'changed too\n');
    await expect(page.getByTestId('wip-count-modified')).toContainText('2', { timeout: 10_000 });
  });

  test('a commit made on the command line shows as a new graph row and the selection is kept', async ({ page }) => {
    const repo = createRepo('live-commit', [
      { message: 'First commit', files: { 'a.txt': 'one\n' } },
      { message: 'Second commit', files: { 'b.txt': 'two\n' }, date: '2026-01-02T10:00:00+00:00' },
    ]);
    await gotoOpenView(page);
    await openRepoByPath(page, repo);
    await expect(page.getByTestId('commit-row')).toHaveCount(2);

    const first = page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: 'First commit' }) });
    await first.click();
    await expect(first).toHaveAttribute('data-selected', 'true');
    const sha = await first.getAttribute('data-sha');
    expect(sha).toBeTruthy();

    cliCommit(repo, 'c.txt', 'three\n', 'Committed from the CLI');

    const added = page.getByTestId('commit-row').filter({ has: page.getByTestId('commit-message').filter({ hasText: 'Committed from the CLI' }) });
    await expect(added).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId('commit-row')).toHaveCount(3);
    await expect(page.locator(`[data-testid="commit-row"][data-sha="${sha}"]`)).toHaveAttribute('data-selected', 'true');
  });
});
