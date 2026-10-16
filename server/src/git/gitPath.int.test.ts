import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GIT_PATH, resolveGitPath, runGit, runGitProgress, runGitStream } from './runner';

vi.setConfig({ testTimeout: 60_000 });

/*
 * Security (V6 audit item 1, existing code fixed in the V2 build): git is spawned by its absolute path, resolved once from PATH, never found in a
 * repository folder. A git.exe (Windows) / git script (POSIX) planted at a repo root must never run.
 * The plant on Windows is a copy of node.exe: if it ever ran as "git", NODE_OPTIONS (set for this test only) would make it write a marker file.
 * Everything is under os.tmpdir()/gitslappin-tests; nothing is deleted.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
const fwd = (p: string): string => p.replace(/\\/g, '/');

function setup(): { repo: string; hook: string; plant: string } {
  const repo = join(fresh('gitpath'), 'r');
  mkdirSync(repo);
  execFileSync(GIT_PATH, ['init', '-b', 'main'], { cwd: repo, windowsHide: true });
  const hook = join(fresh('gitpath-hook'), 'marker-hook.js');
  writeFileSync(hook, "require('fs').appendFileSync(process.env.GS_MARKER, 'ran\\n');\n");
  let plant: string;
  if (process.platform === 'win32') {
    plant = join(repo, 'git.exe');
    copyFileSync(process.execPath, plant);
  } else {
    plant = join(repo, 'git');
    writeFileSync(plant, '#!/bin/sh\necho ran >> "$GS_MARKER"\nexit 0\n', { mode: 0o755 });
  }
  return { repo, hook, plant };
}

async function withMarker<T>(hook: string, marker: string, fn: () => Promise<T>): Promise<T> {
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, GS_MARKER: process.env.GS_MARKER };
  process.env.NODE_OPTIONS = `--require "${fwd(hook)}"`;
  process.env.GS_MARKER = marker;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('git is spawned by an absolute path from PATH', () => {
  it('GIT_PATH is absolute (git is on PATH here) and resolveGitPath ignores relative and empty PATH entries', () => {
    expect(isAbsolute(GIT_PATH)).toBe(true);
    expect(resolveGitPath(['', '.', 'relative-dir'].join(process.platform === 'win32' ? ';' : ':'))).toBe(''); // nothing absolute on it: empty, never the bare name or a cwd lookup
    expect(resolveGitPath('')).toBe('');
  });

  it('a planted git.exe / git at the repo root never runs (runGit, runGitStream, runGitProgress); the real git does the work', async () => {
    const { repo, hook, plant } = setup();
    // control: the plant really does leave a marker when it is run (so a missing marker below means something)
    const control = join(fresh('gitpath-control'), 'control.txt');
    const ran = spawnSync(plant, process.platform === 'win32' ? ['-e', '0'] : [], { cwd: repo, windowsHide: true, env: { ...process.env, NODE_OPTIONS: `--require "${fwd(hook)}"`, GS_MARKER: control } });
    expect(ran.error).toBeUndefined();
    expect(existsSync(control)).toBe(true);

    const marker = join(fresh('gitpath-marker'), 'marker.txt');
    await withMarker(hook, marker, async () => {
      const res = await runGit(['rev-parse', '--show-toplevel'], { cwd: repo });
      expect(res.code).toBe(0);
      expect(resolve(res.stdout.trim()).toLowerCase()).toBe(resolve(repo).toLowerCase());
      let streamed = '';
      const s = await runGitStream(['--version'], { cwd: repo, timeoutMs: 20_000, maxBytes: 10_000, onData: (c) => (streamed += c.toString('utf8')) });
      expect(s.code).toBe(0);
      expect(streamed).toMatch(/^git version /);
      const p = await runGitProgress(['--version'], { cwd: repo, timeoutMs: 20_000, onLine: () => undefined });
      expect(p.code).toBe(0);
    });
    expect(existsSync(marker)).toBe(false);
  });
});
