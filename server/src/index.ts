import type { AddressInfo } from 'node:net';
import { createAutoExit } from './alive';
import { buildApp } from './app';
import { loadConfig, startupUrl } from './config';
import { queryFixedDrives } from './fsList';
import { gitVersionProblem } from './git/version';
import { pendingCount, stopAccepting } from './git/queue';
import { findLiveInstance, writeLock } from './instance';
import { launchWindow } from './launcher';
import { copyLegacyData, defaultDataDirs } from './legacyData';

const problem = await gitVersionProblem();
if (problem) {
  console.error(`GitSlappin cannot start: ${problem}`);
  process.exit(1);
}

const config = loadConfig();

// First start after the rename: copy (never move) the old GitGit settings, only when the default data folder is in use.
if (!process.env.GITSLAPPIN_DATA_DIR) {
  const dirs = defaultDataDirs();
  const copied = copyLegacyData(dirs.current, dirs.legacy);
  if (copied.length > 0) console.log(`GitSlappin: copied ${copied.join(', ')} from ${dirs.legacy} (the old folder is untouched).`);
}

// Single instance: a running GitSlappin (its lock answers /api/ping with the same pid) just gets another window. Dev and test servers (GITSLAPPIN_NO_OPEN) skip this.
if (!config.noOpen) {
  const live = await findLiveInstance(config.dataDir);
  if (live) {
    const liveUrl = `http://127.0.0.1:${live.port}/?token=${live.token}`;
    if (!launchWindow(liveUrl, config.dataDir)) console.log(`GitSlappin is already running at ${liveUrl}`);
    process.exit(0);
  }
}

const tracker = createAutoExit({ pendingCount, stopAccepting, exit: () => process.exit(0) });
const drives = config.repoRoots.length > 0 ? [] : await queryFixedDrives(); // asked once; the folder browser lists these
const app = await buildApp(config, { tracker, drives });
try {
  await app.listen({ host: config.bind, port: config.port });
} catch (e) {
  // Under bind 0.0.0.0 (Docker) the published port must match, so there is no fallback.
  if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || config.bind !== '127.0.0.1') throw e;
  await app.listen({ host: '127.0.0.1', port: 0 }); // the port is taken by something else: take any free one
}
config.port = (app.server.address() as AddressInfo).port; // the host check reads this, and so does the lock

const url = `http://127.0.0.1:${config.port}/?token=${config.token}`;
console.log(`GitSlappin running at ${startupUrl(config)}`);
if (!config.noOpen) {
  writeLock(config.dataDir, { port: config.port, token: config.token, pid: process.pid });
  // Auto-exit is armed only when a window was really opened; without a browser the server stays up for the printed URL.
  if (launchWindow(url, config.dataDir)) tracker.arm();
}
