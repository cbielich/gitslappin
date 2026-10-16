import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RepoRegistry } from '../state/registry';

export type OpenSpawn = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore'; windowsHide?: boolean },
) => { unref(): void; on?(...a: unknown[]): unknown };

const COOLDOWN_MS = 2000;

const sysRoot = (): string => process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
/** Absolute paths only: a bare exe name with cwd = a repo could run a program planted in that repo (V6 audit security 1). */
export const powershellExe = (): string => join(sysRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const explorerExe = (): string => join(sysRoot(), 'explorer.exe');

/** The desktop gate, computed from the server's own facts on every call (V6 audit security 3). */
export function isDesktop(bind: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && bind === '127.0.0.1';
}

/** The shell must not inherit the launch token or any other GITSLAPPIN_* setting (V6 audit security 2). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GITSLAPPIN_/i.test(k)) env[k] = v;
  return env;
}

export function registerOpenRoutes(app: FastifyInstance, registry: RepoRegistry, opts: { bind: string; platform: NodeJS.Platform; spawn: OpenSpawn }): void {
  const last = new Map<string, number>();
  const routes: Array<[string, () => string, string[]]> = [
    ['open-terminal', powershellExe, ['-NoExit']],
    ['open-folder', explorerExe, ['.']],
  ];
  for (const [name, exe, args] of routes) {
    app.post<{ Params: { id: string } }>(`/api/repos/:id/${name}`, async (req, reply) => {
      const root = registry.rootOf(req.params.id);
      if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
      if (!isDesktop(opts.bind, opts.platform)) return reply.code(409).send({ error: 'Not available on this server.' });
      const now = Date.now();
      const prev = last.get(req.params.id);
      if (prev !== undefined && now - prev < COOLDOWN_MS) return reply.code(429).send({ error: 'Too many requests.' });
      const file = exe();
      if (!existsSync(file)) return reply.code(409).send({ error: 'Not available on this server.' });
      last.set(req.params.id, now);
      try {
        const child = opts.spawn(file, args, { cwd: root, env: cleanEnv(), detached: true, stdio: 'ignore', windowsHide: false });
        child.on?.('error', () => undefined);
        child.unref();
      } catch {
        return reply.code(500).send({ error: 'Failed to open repo in terminal' });
      }
      return reply.send({ ok: true });
    });
  }
}
