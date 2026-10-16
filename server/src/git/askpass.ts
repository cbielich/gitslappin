import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EnvOverride } from './runner';

/*
 * The failing credential helper for auto-fetch (V2). Written by the server on every start with fixed content: a file that is already
 * there is never trusted (it is replaced, by rename, so a link planted at that name is replaced and not followed). Owner-only, exec bit on POSIX.
 */

export const ASKPASS_NAME = process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh';
const CONTENT = process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n';

/** Returns the script's path, or undefined when it could not be written (auto-fetch then never runs). */
export function writeAskpass(dataDir: string): string | undefined {
  try {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, ASKPASS_NAME);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, CONTENT, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(tmp, 0o700);
    renameSync(tmp, path);
    return path;
  } catch {
    return undefined;
  }
}

/** The fixed no-prompt environment of an auto-fetch. Values come only from the server. */
export function noPromptEnv(askpass: string): EnvOverride {
  return { GCM_INTERACTIVE: 'never', GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force' };
}
