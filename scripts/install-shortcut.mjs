// Creates GitSlappin.lnk on the Desktop and in the Start Menu (Programs). Windows only.
//   node scripts/install-shortcut.mjs --dry-run [--repo <path>]   prints the plan as JSON and writes nothing
//   node scripts/install-shortcut.mjs [--repo <path>]             writes the two shortcuts
// An existing GitSlappin.lnk is replaced only when its WorkingDirectory is this repo (compared without regard to letter case);
// otherwise the script refuses and writes nothing. Paths reach PowerShell through environment variables, never through the script text.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const POWERSHELL = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const LNK = 'GitSlappin.lnk';

function ps(script, env = {}) {
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

const UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';

/** The Desktop and Programs (Start Menu) folders of this user, from .NET (never guessed from %USERPROFILE%). */
function shortcutFolders() {
  const out = ps(`${UTF8}[Environment]::GetFolderPath('Desktop');[Environment]::GetFolderPath('Programs')`)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (out.length !== 2) throw new Error('Could not find the Desktop and Start Menu folders.');
  return out;
}

/** Pure: what to do with a GitSlappin.lnk whose current WorkingDirectory is `existingWorkingDirectory` (null = no such shortcut). */
export function shortcutAction(existingWorkingDirectory, repo) {
  if (existingWorkingDirectory === null) return 'create';
  const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  return existingWorkingDirectory !== '' && norm(existingWorkingDirectory) === norm(repo) ? 'replace' : 'refuse';
}

/** The plan for a repo folder. `folders` = [Desktop, Programs] (looked up when not given). Writes nothing. */
export function buildShortcutPlan(repo, folders = shortcutFolders()) {
  if (/["\r\n\0]/.test(repo)) throw new Error('The repo path contains a character that cannot be used in a shortcut.');
  // One single-quoted PowerShell literal. PowerShell also treats the curly quotes U+2018-U+201B as single quotes,
  // so every one of them is doubled too.
  const quoted = `'${repo.replace(/['‘’‚‛]/g, (c) => c + c)}'`;
  return {
    repo,
    workingDirectory: repo,
    targetPath: POWERSHELL,
    arguments: `-NoProfile -WindowStyle Hidden -Command Start-Process node -ArgumentList scripts\\start.mjs -WorkingDirectory ${quoted} -WindowStyle Hidden`,
    windowStyle: 7,
    icon: win32.join(repo, 'assets', 'gitslappin.ico'),
    shortcuts: folders.map((dir) => ({ name: LNK, path: win32.join(dir, LNK) })),
  };
}

function existingWorkingDirectory(lnkPath) {
  if (!existsSync(lnkPath)) return null;
  const out = ps(`${UTF8}(New-Object -ComObject WScript.Shell).CreateShortcut($env:GITSLAPPIN_LNK_PATH).WorkingDirectory`, { GITSLAPPIN_LNK_PATH: lnkPath });
  return out.replace(/\r?\n$/, '');
}

const WRITE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:GITSLAPPIN_LNK_PATH)',
  '$s.TargetPath=$env:GITSLAPPIN_LNK_TARGET',
  '$s.Arguments=$env:GITSLAPPIN_LNK_ARGS',
  '$s.WorkingDirectory=$env:GITSLAPPIN_LNK_WD',
  '$s.IconLocation=$env:GITSLAPPIN_LNK_ICON',
  '$s.WindowStyle=[int]$env:GITSLAPPIN_LNK_STYLE',
  "$s.Description='GitSlappin'",
  '$s.Save()',
].join(';');

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const i = argv.indexOf('--repo');
  const repo = i >= 0 && argv[i + 1] ? argv[i + 1] : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = buildShortcutPlan(repo);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    return 0;
  }
  // Decide for both first; one refusal means nothing is written.
  const todo = plan.shortcuts.map((s) => ({ ...s, action: shortcutAction(existingWorkingDirectory(s.path), repo) }));
  const refused = todo.filter((t) => t.action === 'refuse');
  if (refused.length > 0) {
    for (const t of refused) console.error(`Refused: ${t.path} already exists and does not point at ${repo}. Nothing was written.`);
    return 1;
  }
  for (const t of todo) {
    ps(WRITE_SCRIPT, {
      GITSLAPPIN_LNK_PATH: t.path,
      GITSLAPPIN_LNK_TARGET: plan.targetPath,
      GITSLAPPIN_LNK_ARGS: plan.arguments,
      GITSLAPPIN_LNK_WD: plan.workingDirectory,
      GITSLAPPIN_LNK_ICON: plan.icon,
      GITSLAPPIN_LNK_STYLE: String(plan.windowStyle),
    });
    console.log(`${t.action === 'replace' ? 'Updated' : 'Created'} ${t.path}`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
