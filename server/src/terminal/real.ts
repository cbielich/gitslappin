import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Config } from '../config';
import type { RepoRegistry } from '../state/registry';
import { createTerminalHub, type SpawnPty, type TerminalHub } from './hub';

/** node-pty is an optional dependency: if it does not load, the terminal is unavailable and nothing else breaks (design item 1). */
export function loadSpawnPty(): SpawnPty | null {
  try {
    const mod = createRequire(import.meta.url)('node-pty') as { spawn?: unknown };
    return typeof mod.spawn === 'function' ? (mod.spawn as SpawnPty) : null;
  } catch {
    return null;
  }
}

/** The hub for production: real node-pty, real file checks, taskkill by absolute path. `config` is read on every call (the port can change after listen). */
export function createRealTerminalHub(config: Pick<Config, 'bind' | 'port'>, registry: Pick<RepoRegistry, 'rootOf'>): TerminalHub {
  return createTerminalHub({
    spawnPty: loadSpawnPty(),
    platform: process.platform,
    get bind() {
      return config.bind;
    },
    get port() {
      return config.port;
    },
    shellExists: (p) => existsSync(p),
    now: () => Date.now(),
    rootOf: (id) => registry.rootOf(id),
    get env() {
      return process.env;
    },
    systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
    programFiles: process.env.ProgramFiles ?? 'C:\\Program Files',
    runTaskkill: (file, args) => {
      spawnSync(file, args, { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    },
  });
}

const exitHubs = new Set<TerminalHub>();
let exitHooked = false;
/** Synchronous kill-all when the process exits (auto-exit calls process.exit, which skips onClose). One listener for any number of apps. Returns the remover. */
export function killOnExit(hub: TerminalHub): () => void {
  exitHubs.add(hub);
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const h of exitHubs) h.killAll();
    });
  }
  return () => void exitHubs.delete(hub);
}
