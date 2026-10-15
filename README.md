# GitSlappin

A local, GitKraken-style git GUI. A Node server listens on 127.0.0.1 and the UI opens in a browser app window.

## Requirements
- Node 24
- git 2.26 or newer (the server checks this at startup)
- Microsoft Edge or Google Chrome (Windows)

## Use
```
npm install
npm start                      # builds the client if needed, starts the server, opens the app window
npm run install-shortcut       # creates GitSlappin.lnk on the Desktop and in the Start menu
npm run install-shortcut -- --dry-run   # prints the plan as JSON, writes nothing
npm run dev                    # development servers
npm run build                  # build shared, client and server checks
```

## Run with Docker
Optional second way to run GitSlappin. Native `npm start` is unchanged.
```
copy .env.example .env         # then edit .env (never commit it)
docker compose up -d --build
```
Open `http://127.0.0.1:<GITSLAPPIN_PORT>/?token=<your token>` (the startup log prints the URL without the token). The port is published on 127.0.0.1 only.
- Token: at least 32 characters; the `.env.example` placeholder is refused. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. That prints to the terminal only; it writes no file, so paste it into `.env` yourself.
- `/repos` inside the container is your `REPOS_DIR` folder mounted **read-write**. GitSlappin's own git commands (including discard and reset) change those files for real.
- autocrlf: set `GITSLAPPIN_AUTOCRLF` to your Windows value (`git config --global core.autocrlf`). If empty, git's default applies.
- HTTPS credentials are not supported in Docker (no credential manager). Use SSH remotes (keys `id_*` and `known_hosts` from `SSH_DIR` are copied into the container; your ssh `config` is not, and `known_hosts` must list the host), or run natively.
- Passphrase-protected SSH keys do not work in Docker (there is no agent and no prompt). The whole `SSH_DIR` folder is visible inside the container, including to repo hooks, so point `SSH_DIR` at a dedicated folder that holds only the key(s) and `known_hosts` you want GitSlappin to use, not your whole `~/.ssh`.
- Repo hooks are the main residual risk: they run as the container user with network access and the copied SSH keys. Only open repos you trust. The token is removed from the environment of git and hooks.
- `docker inspect` shows the container's environment, including `GITSLAPPIN_TOKEN`. Anyone who can run docker on this machine can read it.
- Another folder: only folders under `/repos` can be opened. Mount it as a sub-folder in `docker-compose.yml`, e.g. add `- type: bind` with `source: D:/work` and `target: /repos/work`, or set `REPOS_DIR` to a parent folder. To allow roots elsewhere, set `GITSLAPPIN_REPO_ROOTS` to several folders separated by `;`.
- Windows paths: in Docker you can type or paste a Windows path such as `C:\repos\demo` into Open; compose sets `GITSLAPPIN_PATH_MAP` (`<REPOS_DIR>=/repos`) so it is translated to `/repos/demo`. A drive path outside the mapped folders is refused, and the mapping never widens `GITSLAPPIN_REPO_ROOTS`.
- Browse: the Open screen has a "Browse" button that lists folders so you don't have to type a path. In Docker it only shows folders under the mounted `REPOS_DIR`.
- Auto-refresh: repo state (changes, branches, current commit) refreshes on its own when files or refs change outside GitSlappin. Set `GITSLAPPIN_WATCH=events` (default) or `poll`; Docker uses `poll`.
- Settings and recent repos live in the `gitslappin-data` volume.

## Tests
```
npx vitest run
npx playwright test --reporter=line
npm run test:docker            # builds the image and runs a smoke test; skips when docker is not available
```
Playwright uses Edge (`channel: 'msedge'`) and builds first (`npm run build`). Fixture repos are created only under the system temp folder (`gitslappin-tests`).

## Data
Recent repos, open tabs, preferences and the single-instance lock live in `%APPDATA%\GitSlappin`. On the first start after the rename from GitGit, recent.json, tabs.json and prefs.json are copied (never moved) from `%APPDATA%\GitGit` when the new folder does not exist yet. Environment variables:
- `GITSLAPPIN_DATA_DIR` - data folder
- `GITSLAPPIN_PORT` - port (default 4417)
- `GITSLAPPIN_TOKEN` - access token (default: random per launch)
- `GITSLAPPIN_NO_OPEN=1` - do not open a window (also turns off auto-exit)
- `GITSLAPPIN_BIND` - `127.0.0.1` (default) or `0.0.0.0` (Docker only; needs `GITSLAPPIN_NO_OPEN=1` and a token of 32+ characters)
- `GITSLAPPIN_REPO_ROOTS` - when set, only repos under these folders (separated by `;`) can be opened
- `GITSLAPPIN_WATCH` - `events` (default) or `poll`; how repo changes are detected for auto-refresh (Docker compose sets `poll`)
- `GITSLAPPIN_PATH_MAP` - Docker only: `host=container` pairs (separated by `;`) used to translate Windows paths typed into Open

## Security model
- The server binds to 127.0.0.1 only.
- Every API call needs the per-launch token (`X-GitSlappin-Token` header); the page moves it from the URL into sessionStorage.
- Git runs only through one runner with validated paths and names, and the token is stripped from git's environment.
