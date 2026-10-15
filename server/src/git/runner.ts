import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { recordCommand } from './commandLog';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  /** Output cap in bytes (default 256 MB). Going over it resolves with code -1. */
  maxBuffer?: number;
  /** When set, the call is recorded in that repo's command log. */
  repoId?: string;
  /** Aborts the git process (the call then resolves with code -1). */
  signal?: AbortSignal;
  /** Bytes written to git's stdin. A string is sent as UTF-8; a Buffer is sent as is. */
  input?: string | Buffer;
  /** How stdout/stderr bytes are read. Default utf8; latin1 keeps every byte exact (one char per byte). */
  encoding?: 'utf8' | 'latin1';
  /** Extra environment for this run (allowlisted keys only, see ENV_OVERRIDE_KEYS). */
  env?: EnvOverride;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
  cb: (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => unknown;

export function buildGitArgs(args: string[]): string[] {
  // fsmonitor off: a repo config must not make us spawn a helper program. Hooks stay enabled on purpose.
  return ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args];
}

/** Variables a caller may set for one run. Fixed keys only; values never come from a request body. */
export const ENV_OVERRIDE_KEYS = ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_MERGE_AUTOEDIT'] as const;
export type EnvOverride = Partial<Record<(typeof ENV_OVERRIDE_KEYS)[number], string>>;

/**
 * The child's environment: ours without the launch token, and without variables that would point git at another
 * repository or inject config. GIT_SSH*, GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL are kept (the user's own setup).
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of Object.keys(env)) {
    if (k === 'GITSLAPPIN_TOKEN' || k === 'GIT_DIR' || k === 'GIT_WORK_TREE' || k === 'GIT_EXTERNAL_DIFF' || k === 'GIT_CONFIG_COUNT' || k === 'GIT_CONFIG_PARAMETERS' || /^GIT_CONFIG_(KEY|VALUE)_/.test(k)) {
      delete env[k];
    }
  }
  return env;
}

function withOverride(env: NodeJS.ProcessEnv, override: EnvOverride | undefined): NodeJS.ProcessEnv {
  if (!override) return env;
  for (const k of ENV_OVERRIDE_KEYS) {
    const v = override[k];
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

export function runGit(args: string[], opts: RunOptions, exec: ExecFileFn = execFile as unknown as ExecFileFn): Promise<GitResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = exec(
      'git',
      buildGitArgs(args),
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
        windowsHide: true,
        encoding: opts.encoding ?? 'utf8',
        env: withOverride(childEnv(), opts.env),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (err, stdout, stderr) => {
        const code = !err ? 0 : typeof err.code === 'number' ? err.code : -1;
        const result: GitResult = {
          code,
          stdout: stdout ?? '',
          stderr: stderr || (err && code === -1 ? err.message : ''),
        };
        if (opts.repoId) {
          recordCommand(opts.repoId, { at: started, args, code, durationMs: Date.now() - started });
        }
        resolve(result);
      },
    ) as ChildProcess | undefined;
    if (opts.input !== undefined && child?.stdin) {
      child.stdin.on('error', () => undefined); // git may exit before reading everything
      child.stdin.end(opts.input);
    }
  });
}

export interface StreamResult {
  code: number;
  timedOut: boolean;
  /** More than maxBytes of stdout came; git was stopped. */
  overflow: boolean;
}

/**
 * Like runGit, but stdout is handed to onData chunk by chunk and never buffered (live auto-refresh hashes it).
 * Never recorded in the command log. A timeout or going over maxBytes stops git and says so in the result.
 */
export function runGitStream(args: string[], opts: { cwd: string; timeoutMs: number; maxBytes: number; onData: (chunk: Buffer) => void }): Promise<StreamResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let overflow = false;
    let bytes = 0;
    let done = false;
    const child = spawn('git', buildGitArgs(args), { cwd: opts.cwd, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, timedOut, overflow });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(-1);
    }, opts.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > opts.maxBytes) {
        overflow = true;
        child.kill();
        finish(-1);
        return;
      }
      opts.onData(chunk);
    });
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  });
}
