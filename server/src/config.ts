import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDirs } from './legacyData';
import { parsePathMap, type PathPair } from './pathMap';

export interface Config {
  port: number;
  token: string;
  dataDir: string;
  clientDist: string;
  noOpen: boolean;
  /** `127.0.0.1` (default) or `0.0.0.0` (Docker mode only). */
  bind: string;
  /** When not empty, only repos whose real path is under one of these folders may be opened (Docker mode). */
  repoRoots: string[];
  /** Docker mode: Windows host folder -> container folder pairs for the Open box (GITSLAPPIN_PATH_MAP). Empty in native mode. */
  pathMap: PathPair[];
  /** Live auto-refresh: `events` (file watcher, default) or `poll` (timer; for Docker bind mounts that send no file events). */
  watch: 'events' | 'poll';
}

/** The token text in `.env.example`. It is refused as a token under bind 0.0.0.0. */
export const PLACEHOLDER_TOKEN = 'change-me-to-a-long-random-token-0000';
const MIN_DOCKER_TOKEN = 32;
/** Separator between several folders in GITSLAPPIN_REPO_ROOTS (`;`, because Windows paths contain `:`). */
export const REPO_ROOTS_SEPARATOR = ';';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.GITSLAPPIN_PORT ?? 4417);
  const defaultDataDir = defaultDataDirs(env).current;

  const bind = env.GITSLAPPIN_BIND || '127.0.0.1';
  if (bind !== '127.0.0.1' && bind !== '0.0.0.0') throw new Error('GITSLAPPIN_BIND must be 127.0.0.1 or 0.0.0.0.');
  if (bind === '0.0.0.0') {
    if (env.GITSLAPPIN_NO_OPEN !== '1') throw new Error('GITSLAPPIN_BIND=0.0.0.0 needs GITSLAPPIN_NO_OPEN=1.');
    const t = env.GITSLAPPIN_TOKEN ?? '';
    if (t.length < MIN_DOCKER_TOKEN) throw new Error(`GITSLAPPIN_BIND=0.0.0.0 needs GITSLAPPIN_TOKEN of at least ${MIN_DOCKER_TOKEN} characters.`);
    if (t === PLACEHOLDER_TOKEN) throw new Error('GITSLAPPIN_TOKEN is still the placeholder from .env.example. Generate a real one.');
  }

  const watch = env.GITSLAPPIN_WATCH || 'events';
  if (watch !== 'events' && watch !== 'poll') throw new Error('GITSLAPPIN_WATCH must be events or poll.');

  const repoRoots = (env.GITSLAPPIN_REPO_ROOTS ?? '')
    .split(REPO_ROOTS_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s));

  return {
    port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 4417,
    token: env.GITSLAPPIN_TOKEN || randomBytes(24).toString('base64url'),
    dataDir: resolve(env.GITSLAPPIN_DATA_DIR || defaultDataDir),
    clientDist: fileURLToPath(new URL('../../client/dist', import.meta.url)),
    noOpen: env.GITSLAPPIN_NO_OPEN === '1',
    bind,
    repoRoots,
    pathMap: parsePathMap(env.GITSLAPPIN_PATH_MAP),
    watch,
  };
}

/** The URL printed at startup. Under bind 0.0.0.0 it has no token, so `docker logs` does not leak it. */
export function startupUrl(config: Config): string {
  const base = `http://127.0.0.1:${config.port}/`;
  return config.bind === '0.0.0.0' ? base : `${base}?token=${config.token}`;
}
