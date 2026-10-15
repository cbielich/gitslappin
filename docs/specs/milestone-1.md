# Spec: GitGit milestone 1

Status: audited (round 1 complete, nothing disputed). Awaiting user approval. Nothing built.

## Goal
GitGit is an installable Windows desktop Git client, written from scratch (no code, assets or branding copied from any other product). Milestone 1 is read-only: open a local repo, list branches, see a commit graph with branch lanes, click a commit to see its diff. Later (not now): stage/commit, push/pull/fetch, merge, stash, tags, conflict resolution.

## Facts (verified)
- Node v24.22.0; git 2.56.0 at `C:\Program Files\Git\cmd\git.exe`, NOT on PATH. PowerShell 5.1, Windows 11.
- `C:\repos\gitgit` is empty, no package.json, no Playwright config. Playwright must be set up in this folder (`npm init playwright@latest`) with the user's go.
- `git log --no-color --topo-order --decorate=full -z --format=%H%x00%P%x00%D%x00%an%x00%ae%x00%aI%x00%s%x00%b` (tested): fields AND records are all NUL-separated, so the parser reads fixed groups of 8 fields. Body is last (may contain newlines). `%D` looks like `HEAD -> refs/heads/master`.
- Electron stable 44.7.2 (Node 24.21.0), per releases.electronjs.org on 2026-10-14. Playwright supports Electron via `_electron.launch` (experimental, v21+); native dialogs are not intercepted, so tests stub them with `electronApp.evaluate()`.

## Decisions
1. Stack: electron-vite (main/preload/renderer) + React + TypeScript strict + electron-builder NSIS. Pin Electron major 44. Unit/integration: vitest. E2E: @playwright/test with `_electron`.
2. Layout: `src/shared` (ipc.ts, types.ts, validate.ts, logParser.ts, graph.ts; pure), `src/main` (index, gitLocator, gitRunner, repoService, ipcHandlers), `src/preload/index.ts` (contextBridge `gitgit`), `src/renderer` (App, NoGitScreen, OpenRepoScreen, BranchList, CommitGraph, CommitDetails, DiffView), `tests/{unit,integration,e2e,fixtures}`.
3. Security: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, `webSecurity:true`; strict CSP (`default-src 'self'`); window-open denied, navigation blocked; every IPC handler checks `event.senderFrame.url` is the app's own origin. Git spawned only via `spawn(gitPath, args, {shell:false, cwd: repoRoot, windowsHide:true})`; first-arg allowlist: `--version`, `rev-parse`, `for-each-ref`, `log`, `show`; every call prefixed `-c core.fsmonitor=false -c core.quotepath=false -c i18n.logOutputEncoding=UTF-8`; env `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`; `show` always gets `--no-ext-diff --no-textconv`. Repo path validated once (absolute, exists, directory, `rev-parse --show-toplevel` ok) and kept in main; renderer later sends only a sha (`/^[0-9a-f]{40}([0-9a-f]{24})?$/`) and, for a diff, a path that must be in that commit's main-computed file list.
   Hardening added after the security audit:
   - Every git call also gets `-c log.showSignature=false -c protocol.allow=never -c diff.submodule=short -c color.ui=false --no-pager --literal-pathspecs`; `log`/`show` also get `--no-show-signature`. Never use `%G` format codes. Never set `safe.directory`; a "dubious ownership" error reaches the user as an error banner.
   - Child env = `process.env` with every `GIT_*` key removed, plus the app's own vars (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`).
   - Diff form: `show <opts> --end-of-options <sha> -- <path>`. File lists use `-z` and the parser handles C-quoting. Tests with files named `--output=pwn` and `*`.
   - gitRunner counts stdout bytes as they stream and kills the child at the cap: 2 MB per diff, 64 MB for the whole log reply. Hardcoded timeouts: 60 s for log, 15 s for everything else. Timeout/overflow returns `{ok:false}` (log) or `truncated:true` (diff). Subject trimmed to 1 KB, body to 16 KB; `commitFiles` capped at 5,000 entries with `truncated:true`; the log parser errors out on any record whose sha/parent fields fail the sha regex.
   - Renderer is served from `app://gitgit/` via `protocol.handle` (privileged/standard/secure); resolved paths must stay inside the app bundle, else 404. IPC accepted only if `senderFrame` is non-null, is `win.webContents.mainFrame`, and its URL starts with `app://gitgit/`. Dev-server origin and dev CSP exist only in dev builds. CSP also has `object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`. Block `will-frame-navigate` and `will-redirect`, prevent `will-attach-webview`, deny every permission request.
   - Preload exposes one named function per channel, never a generic `invoke`. `dangerouslySetInnerHTML` and HTML-producing diff highlighters are banned; SVG holds text nodes only. The e2e fixture includes a commit whose subject is `<img src=x onerror=alert(1)>`, and a test asserts it renders as literal text.
4. IPC (all invoke; return `{ok:true,data}|{ok:false,error:{code,message}}`): `app:getStatus` (returns the result cached at startup), `app:openGitDownload` (no arguments; opens the hardcoded `https://git-scm.com/download/win`; there is no generic openExternal), `repo:pickAndOpen` (main-side dialog; the ONLY way the renderer opens a repo; startup argv goes through the same main-only validation function, which rejects UNC, `\\?\` and `\\.\` paths; there is no `repo:open` channel), `repo:branches`, `repo:log` (all commits + graph rows in one reply), `repo:commitFiles {sha}`, `repo:fileDiff {sha,path}`. Diff output over 2 MB, or over 5,000 lines shown, is cut with `truncated:true` and the UI says so (hardcoded, no setting). Merge commits show the first-parent diff (`--diff-merges=first-parent`).
5. Log command adds `--branches --remotes HEAD`. Branches via `for-each-ref --format=%(refname)%00%(objectname)%00%(HEAD) refs/heads refs/remotes`.
6. Lane algorithm (pure, in `graph.ts`, runs in main): walk commits in topo order keeping lanes each expecting a sha; commit takes leftmost lane expecting it else first free; other lanes expecting it merge and free; first parent takes the lane; extra parents reuse a lane already expecting them else a new slot. Each row records lane, colour index and line segments; the renderer draws one inline SVG per row. O(commits x active lanes). Row shape is compact: `{lane, color, passing:number[], edges:[{fromLane,toLane,color}]}` (passing = lanes passing through; edges = only the commit's own parent links; no object per segment). At most 40 lanes drawn (the rest collapse to one "+N" marker); every parent is processed for correctness but at most 8 parent edges are drawn per commit.
7. Rendering at 10k: load all once; hand-rolled virtualised list, fixed 24px rows, only visible rows + ~20 extra inside a spacer of n*24. Clicking a branch scrolls to its tip. Stream/chunk the log only if the measured load is too slow.
8. Finding git, first that passes `git --version` wins: (1) env `GITGIT_GIT_PATH` (escape hatch + test hook, no UI; if set but invalid it is an error, no fallback); (2) each PATH entry + `git.exe`; (3) registry `InstallPath` under `HKLM\SOFTWARE\GitForWindows`, `HKLM\SOFTWARE\WOW6432Node\GitForWindows`, then HKCU, + `\cmd\git.exe`, read via `reg.exe query` with an args array; (4) `%ProgramFiles%\Git\cmd\git.exe`, `%ProgramFiles(x86)%\Git\cmd\git.exe`, `%LOCALAPPDATA%\Programs\Git\cmd\git.exe`. PATH entries that are not absolute are skipped; each candidate file's existence is checked before running `git --version`; `reg.exe` is spawned as `%SystemRoot%\System32\reg.exe`. The locator runs once at startup and the result is kept in main. If none: `NoGitScreen` lists every place searched and links to git-scm.com (`shell.openExternal` limited to that one URL).
9. Test hooks: startup arg `--open-repo=<path>` (or a bare path) goes through the same main-side validation as `repo:pickAndOpen`; data-testids: `open-repo-button`, `repo-name`, `branch-list`, `branch-item-<name>`, `commit-graph`, `commit-row` (with `data-sha`), `commit-details`, `file-item` (with `data-path`), `diff-view`, `diff-truncated`, `no-git-error`, `error-banner`.
10. Explicitly out of M1: any write to a repo, settings UI, code signing, auto-update, other platforms, GitKraken-style integrations/accounts/themes.

11. Electron fuses (release build only): RunAsNode off, EnableNodeOptionsEnvironmentVariable off, EnableNodeCliInspectArguments off, OnlyLoadAppFromAsar on, flipped in an electron-builder afterPack step. Playwright `_electron.launch` needs the inspect fuse left on, so Phase 5 builds the app twice: a "test" build with no fuses flipped (full Playwright e2e runs against it) and a "release" build with fuses flipped (checked by reading the fuses on the packaged exe, plus the user's manual install/launch/open-folder/uninstall check). Known leftover risk: automated e2e never runs on the exact fused binary.
12. Screen text (one name per thing: "project folder", never repo/repository/path; "Changes", never diff; "ID", never sha/hash; test ids and code identifiers keep their names):
   - Button "Open folder"; picker title "Choose a project folder"; headings "Branches", "History", details labels "Author", "Date", "Changed files"; dates like "14 Oct 2026"; current branch tagged "current"; branch names shown without `refs/heads/` or `refs/remotes/` (remote shown as `origin/main`, group heading "Remote"); 7-character ID shown only in the details panel.
   - File status words: Added, Changed, Deleted, Renamed (renames show "old name → new name"). Merge commit line: "Merge commit. Showing what it changed on its own branch."
   - Changes view: binary "Can't show this file. It isn't text."; none "No changes to show."; truncated "This change is too large to show in full. Showing the first 2 MB." (same notice for the line cap, worded to match).
   - NoGitScreen: title "Git isn't installed"; body "GitGit needs Git to read your projects. We looked in these places and didn't find it:" + list of plain paths ("Your system's program list (PATH)", "Windows install records"); link "Get Git from git-scm.com"; "Then reopen GitGit." If `GITGIT_GIT_PATH` is set but invalid: title "Git not found at the set location", body "GitGit was told to use Git at <path>, but it doesn't work there."
   - Error banners by code, never raw messages: "That folder doesn't exist." / "That isn't a folder." / "This folder isn't a Git project." / "Git couldn't read this project. Try again." / "Couldn't load that commit." / "Couldn't load that file."
   - Empty states: "Open a project folder to see its history." / "No commits yet." / "No branches yet." / "Select a commit to see what changed." / "This commit changed no files." / "Select a file to see its changes." Loading: "Loading history…".
13. Known leftover risk, no fix possible: a repo's `.git/config` `include.path`, `mailmap.file` or `core.attributesFile` pointing at a UNC path makes git connect to that host and leak the user's NTLM hash. All Git clients share this exposure.

## Phases
1. Scaffold + git service (electron-vite, React, TS, security settings, gitLocator, gitRunner allowlist, `app:getStatus`, NoGitScreen, vitest, one Playwright smoke test). Needs Playwright setup in this folder.
2. Open repo + branches.
3. Graph (logParser, graph.ts, `repo:log`, virtualised CommitGraph, branch click-to-scroll).
4. Diff (`repo:commitFiles`, `repo:fileDiff`, CommitDetails, DiffView, 2 MB cap).
5. Installer (electron-builder NSIS; confirm config keys against official docs first; run Playwright against the packaged app; manual install/uninstall check).

## Tests
- Unit (vitest): logParser (newline bodies, empty body, root, merges, %D), graph.ts (linear, branch+merge, octopus, criss-cross, lane reuse), validate.ts, gitLocator (fake fs/env/reg, none-found), gitRunner allowlist rejects anything else.
- Integration (vitest + real git on generated fixture repos in a temp dir, incl. a 10k-commit one via `git fast-import`): branches, merge, rename, binary file.
- Playwright (Electron): open via arg -> branches -> graph rows -> click commit -> files -> click file -> diff; merge commit first-parent diff; dialog path with the dialog stubbed; no-git screen with `GITGIT_GIT_PATH` invalid; 10k fixture: graph appears within a time budget, `commit-row` DOM nodes <= 100, scroll to bottom shows the root commit.

### Test-data rules (database-safety, cannot be overruled)
- Fixture repos are created only in a fresh, uniquely named, self-created directory; the code asserts it is new and empty before writing. No cleanup, teardown or `afterAll` deletion anywhere; no `git clean`, `reset`, `checkout -f`, `gc --prune`, `rm -rf` or `Remove-Item` in any test or script; no reset-fixtures helper.
- The 10k fixture is cached; regeneration is skipped when a read-only `rev-parse HEAD` matches the expected sha. It has about 150 branches (about 30 long-lived unmerged) and some merges, so it exercises many open lanes.
- Every Playwright run uses a fresh unique `--user-data-dir`, left in place. Phase 5 uninstall is manual, by the user only.
- Added tests: octopus merge (12 parents) and 60 open lanes; files named `--output=pwn` and `*`; both diff caps (2 MB and 5,000 lines); partial-clone fixture with a missing blob must fail with no network or process launch; "dubious ownership" shows an error banner; the hostile commit subject renders as literal text.

## UNVERIFIED (must be settled in the phase named, not assumed)
- Git 2.56 honours `GIT_NO_LAZY_FETCH` (Phase 1: partial-clone fixture test; not built on until it passes).
- Electron 44 fuse names, the electron-builder `afterPack` hook, and the command to read fuses from the packaged exe (Phase 1/5, from official docs).
- electron-vite v6 and Playwright `_electron` work with Electron 44.7.2 (Phase 1 smoke test).
- electron-builder NSIS config keys/defaults (Phase 5, read official docs first).
- Registry `InstallPath` exists on this machine (locator falls back to Program Files anyway).
- SmartScreen warning for an unsigned installer (affects only what the user sees).
- 10k-commit load time (Phase 3 scale test).
- NEEDS APP CHECK: scroll feel at 10k, a human scrolls it once.

## Audits
Round 1 done. security-auditor: 11 objections, all fixed (nothing overruled). scale-auditor: 3 objections, all fixed. words-auditor: strings adopted (Decision 12). db-safety-auditor: no objections; its rules are in Test-data rules. Nothing disputed. ai-cost-auditor and outside research beyond what is cited: not needed (no model calls).

## As-built notes
(to be added by finisher)
