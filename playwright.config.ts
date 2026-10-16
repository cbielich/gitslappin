import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 4518;
const TOKEN = 'test-token';
const dataDir = mkdtempSync(join(tmpdir(), 'gitslappin-e2e-data-'));
// Isolation for git: no system or global config (insteadOf rules, autocrlf, credential helpers) and a credential prompt that fails.
const emptyGlobalConfig = join(dataDir, 'empty.gitconfig');
writeFileSync(emptyGlobalConfig, '');
const failingAskpass = join(dataDir, process.platform === 'win32' ? 'fail-askpass.cmd' : 'fail-askpass.sh');
writeFileSync(failingAskpass, process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'msedge',
    extraHTTPHeaders: {},
  },
  metadata: { token: TOKEN },
  webServer: {
    command: 'npm run build && npm start',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      GITSLAPPIN_PORT: String(PORT),
      GITSLAPPIN_TOKEN: TOKEN,
      GITSLAPPIN_NO_OPEN: '1',
      GITSLAPPIN_DATA_DIR: dataDir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyGlobalConfig,
      // Create (init) makes an "Initial commit"; the empty global config has no identity.
      GIT_AUTHOR_NAME: 'GitSlappin Test',
      GIT_AUTHOR_EMAIL: 'test@gitslappin.invalid',
      GIT_COMMITTER_NAME: 'GitSlappin Test',
      GIT_COMMITTER_EMAIL: 'test@gitslappin.invalid',
      GIT_ASKPASS: failingAskpass,
      SSH_ASKPASS: failingAskpass,
      GCM_INTERACTIVE: 'never',
    },
  },
});
