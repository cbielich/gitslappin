// Dev runner: server (tsx watch) on 4417 with a fixed token + Vite dev server on 5173 (proxies /api).
import { spawn } from 'node:child_process';

const env = { ...process.env, GITSLAPPIN_TOKEN: 'dev-token', GITSLAPPIN_PORT: '4417', GITSLAPPIN_NO_OPEN: '1' };
const run = (args) => spawn('npm', args, { stdio: 'inherit', shell: true, env });

console.log('GitSlappin dev: open http://localhost:5173/?token=dev-token');
const children = [run(['run', 'dev', '-w', 'server']), run(['run', 'dev', '-w', 'client'])];
const stop = () => children.forEach((c) => c.kill());
process.on('SIGINT', stop);
process.on('exit', stop);
