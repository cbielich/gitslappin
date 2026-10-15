import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Phase 12 (not built yet). Expected in scripts/install-shortcut.mjs:
 *  - CLI: `node scripts/install-shortcut.mjs --dry-run [--repo <path>]` prints the plan as JSON on stdout and writes nothing.
 *    `--repo` overrides the default (the folder above scripts/); the path need not exist.
 *  - plan = { dryRun: true, repo, workingDirectory (= repo), arguments (string), windowStyle: 7, icon (ends with assets\gitslappin.ico),
 *             shortcuts: [{ name: 'GitSlappin.lnk', path }, { name: 'GitSlappin.lnk', path }]   // Desktop and Programs, resolved with GetFolderPath
 *  - exports (guarded so importing does not run the CLI): buildShortcutPlan(repo), shortcutAction(existingWorkingDirectory | null, repo) -> 'create' | 'replace' | 'refuse'
 *    (replace only when the existing .lnk WorkingDirectory equals the repo root, compared case-insensitively).
 * NOTE: root vitest.config.ts include globs do not cover scripts/ (shared, server, client only), so this file is not collected until 'scripts/**\/*.test.ts' is added.
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'install-shortcut.mjs');
const HOSTILE = `C:\\gitslappin-test-hostile\\it's $env:USERNAME; calc & 'x' \u2018a\u2019 \u201Ab\u201B`;

interface Plan {
  dryRun: boolean;
  repo: string;
  workingDirectory: string;
  arguments: string;
  windowStyle: number;
  icon: string;
  shortcuts: { name: string; path: string }[];
}

function dryRun(repo?: string): { plan: Plan; raw: string } {
  const args = [SCRIPT, '--dry-run', ...(repo ? ['--repo', repo] : [])];
  const raw = execFileSync('node', args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { plan: JSON.parse(raw) as Plan, raw };
}
const snapshot = (p: string) => (existsSync(p) ? `exists:${statSync(p).mtimeMs}:${statSync(p).size}` : 'absent');

describe('install-shortcut --dry-run', () => {
  it('prints a plan for Desktop and Programs and writes no .lnk (state before == after)', () => {
    const first = dryRun().plan;
    expect(first.dryRun).toBe(true);
    expect(first.shortcuts).toHaveLength(2);
    for (const s of first.shortcuts) expect(s.name).toBe('GitSlappin.lnk');
    const before = first.shortcuts.map((s) => snapshot(s.path));
    const again = dryRun().plan;
    expect(again.shortcuts.map((s) => s.path)).toEqual(first.shortcuts.map((s) => s.path)); // the code path ran and resolved the same folders
    expect(again.shortcuts.map((s) => snapshot(s.path))).toEqual(before);
  });

  it('uses the fixed target, hidden window style 7 and the icon', () => {
    const { plan } = dryRun();
    expect(plan.windowStyle).toBe(7);
    expect(plan.icon.replace(/\//g, '\\')).toMatch(/assets\\gitslappin\.ico$/);
    expect(plan.arguments).toContain('-NoProfile -WindowStyle Hidden -Command Start-Process node');
    expect(plan.arguments).toContain('-ArgumentList scripts\\start.mjs');
    expect(plan.arguments).toContain('-WindowStyle Hidden');
  });

  it('hostile repo path: every single quote is doubled inside one single-quoted literal; nothing is executed', () => {
    const { plan } = dryRun(HOSTILE);
    // PowerShell treats ' and the curly quotes U+2018-U+201B alike, so every one of them is doubled.
    const escaped = HOSTILE.replace(/['\u2018\u2019\u201A\u201B]/g, (c) => c + c);
    expect(plan.repo).toBe(HOSTILE);
    expect(plan.workingDirectory).toBe(HOSTILE);
    expect(escaped).toBe(`C:\\gitslappin-test-hostile\\it''s $env:USERNAME; calc & ''x'' \u2018\u2018a\u2019\u2019 \u201A\u201Ab\u201B\u201B`);
    expect(plan.arguments).toContain(`-WorkingDirectory '${escaped}'`); // the whole path sits inside one literal, `'` doubled
    expect(plan.arguments).not.toMatch(/-WorkingDirectory C:/); // never an unquoted path
    expect(plan.arguments.split(HOSTILE).length).toBe(1); // the raw (unescaped) path never appears
  });

  it('writes nothing for the hostile path either', () => {
    const first = dryRun().plan.shortcuts.map((s) => snapshot(s.path));
    dryRun(HOSTILE);
    expect(dryRun().plan.shortcuts.map((s) => snapshot(s.path))).toEqual(first);
  });
});

describe('refuse rule (shortcutAction, pure)', () => {
  const load = async () =>
    (await import(pathToFileURL(SCRIPT).href)) as {
      shortcutAction: (existing: string | null, repo: string) => 'create' | 'replace' | 'refuse';
    };
  const REPO = 'C:\\repos\\gitslappin';

  it('creates when no shortcut exists', async () => {
    expect((await load()).shortcutAction(null, REPO)).toBe('create');
  });
  it('replaces a shortcut that already points at this repo, ignoring letter case', async () => {
    const { shortcutAction } = await load();
    expect(shortcutAction('C:\\repos\\gitslappin', REPO)).toBe('replace');
    expect(shortcutAction('c:\\REPOS\\GitSlappin', REPO)).toBe('replace');
  });
  it('refuses a shortcut that points anywhere else', async () => {
    const { shortcutAction } = await load();
    for (const other of ['C:\\repos\\other', 'D:\\repos\\gitslappin', 'C:\\repos\\gitslappin-copy', 'C:\\repos', '']) {
      expect(shortcutAction(other, REPO), other).toBe('refuse');
    }
  });
});
