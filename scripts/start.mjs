// GitSlappin launcher: builds the client only when client/dist is missing or older than its sources, then starts the server (tsx).
// Environment (GITSLAPPIN_PORT, GITSLAPPIN_TOKEN, GITSLAPPIN_NO_OPEN, GITSLAPPIN_DATA_DIR, ...) is passed through unchanged.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Newest modification time under a file or folder (0 when it does not exist). */
function newest(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let best = st.mtimeMs;
  for (const name of readdirSync(path)) {
    if (name === 'node_modules') continue;
    best = Math.max(best, newest(join(path, name)));
  }
  return best;
}

function clientIsStale() {
  const built = join(root, 'client', 'dist', 'index.html');
  if (!existsSync(built)) return true;
  const builtAt = statSync(built).mtimeMs;
  const sources = [
    join(root, 'client', 'src'),
    join(root, 'client', 'public'),
    join(root, 'client', 'index.html'),
    join(root, 'client', 'package.json'),
    join(root, 'client', 'vite.config.ts'),
    join(root, 'client', 'tsconfig.json'),
    join(root, 'shared', 'src'),
  ];
  return sources.some((s) => newest(s) > builtAt);
}

if (clientIsStale()) {
  console.log('GitSlappin: building the client...');
  const res = spawnSync('npm', ['run', 'build', '-w', 'client'], { cwd: root, stdio: 'inherit', shell: true });
  if (res.status !== 0) {
    console.error('GitSlappin: the client build failed.');
    process.exit(res.status ?? 1);
  }
}

const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const server = spawn(process.execPath, [tsx, 'src/index.ts'], { cwd: join(root, 'server'), stdio: 'inherit', env: process.env });
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
