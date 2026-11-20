import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isProgramFileType, resolveEditor } from '../git/fileOpen';
import { runGit, type GitResult, type RunOptions } from '../git/runner';
import { UnsafePathError, assertWorkingTreeFile, safeRepoPath } from '../git/safeRepoPath';
import type { RepoRegistry } from '../state/registry';

export type OpenSpawn = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore'; windowsHide?: boolean; windowsVerbatimArguments?: boolean },
) => { unref(): void; on?(...a: unknown[]): unknown };

/** Runs `git difftool` (injectable so tests never start a real tool). Default: runGit. */
export type DifftoolRunner = (args: string[], opts: RunOptions) => Promise<GitResult>;

const COOLDOWN_MS = 2000;
const DIFFTOOL_TIMEOUT_MS = 30 * 60 * 1000;
const SHA = /^[0-9a-f]{40,64}$/;

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

/** Control and bidi characters out of a name that goes into an error text. */
const plain = (s: string): string =>
  Array.from(s, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    const hidden = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    return hidden ? '?' : ch;
  }).join('');

export function registerOpenRoutes(
  app: FastifyInstance,
  registry: RepoRegistry,
  opts: { bind: string; platform: NodeJS.Platform; spawn: OpenSpawn; editor?: string; difftoolRunner?: DifftoolRunner },
): void {
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

  // ---- commit file menu (S5): open a file, or run `git difftool` on it. Order: 404, desktop 409, cooldown 429, then the path checks, then git. ----
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  /** false = the reply is already sent. The cooldown timestamp is taken by the caller once the request is accepted. */
  const gate = (repoId: string, reply: FastifyReply): boolean => {
    if (!isDesktop(opts.bind, opts.platform)) {
      void reply.code(409).send({ error: 'Not available on this server.' });
      return false;
    }
    const prev = last.get(repoId);
    if (prev !== undefined && Date.now() - prev < COOLDOWN_MS) {
      void reply.code(429).send({ error: 'Too many requests.' });
      return false;
    }
    return true;
  };
  const unsafe = (reply: FastifyReply, e: unknown) => reply.code(e instanceof UnsafePathError ? 400 : 500).send({ error: e instanceof UnsafePathError ? e.message : 'Request failed.' });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/file/open', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    if (!gate(repoId, reply)) return reply;
    try {
      if (!isObj(req.body)) return reply.code(400).send({ error: 'Invalid request.' });
      const { path, how } = req.body;
      if (how !== 'editor' && how !== 'default' && how !== 'show') return reply.code(400).send({ error: 'Invalid request.' });
      if (typeof path !== 'string') return reply.code(400).send({ error: 'Missing path.' });
      const abs = safeRepoPath(root, path);
      if (abs.includes('"')) return reply.code(400).send({ error: 'Invalid path.' });
      const name = plain(path.slice(path.lastIndexOf('/') + 1));
      // "Open file in default program" is refused for file types that run as a program (spec section 8).
      if (how === 'default' && isProgramFileType(path, process.env.PATHEXT ?? '')) return reply.code(400).send({ error: `Failed to open ${name}: this file type runs as a program` });
      // The file must exist as a regular file (no link, no folder) whose real location is inside the repo; a missing file is refused and nothing is spawned.
      if (!assertWorkingTreeFile(root, abs)) return reply.code(404).send({ error: `Failed to open ${name}: file does not exist` });

      let file: string;
      let args: string[];
      let verbatim = false;
      if (how === 'editor') {
        const editor = resolveEditor(opts.editor ?? '', process.env, existsSync);
        if (!editor.ok) return reply.code(409).send({ error: editor.error });
        file = editor.file;
        args = [abs];
      } else {
        file = explorerExe();
        if (!existsSync(file)) return reply.code(409).send({ error: 'Not available on this server.' });
        args = [how === 'show' ? `/select,"${abs}"` : `"${abs}"`];
        verbatim = true;
      }
      last.set(repoId, Date.now());
      try {
        const child = opts.spawn(file, args, { cwd: root, env: cleanEnv(), detached: true, stdio: 'ignore', windowsHide: false, ...(verbatim ? { windowsVerbatimArguments: true } : {}) });
        child.on?.('error', () => undefined);
        child.unref();
      } catch {
        return reply.code(500).send({ error: `Failed to open ${name}: unknown error` });
      }
      return reply.send({ ok: true });
    } catch (e) {
      return unsafe(reply, e);
    }
  });

  const difftoolBusy = new Set<string>();
  const runDifftool: DifftoolRunner = opts.difftoolRunner ?? ((args, o) => runGit(args, o));
  const quiet = (root: string, repoId: string, args: string[], input?: string) => runGit(args, { cwd: root, repoId, ...(input === undefined ? {} : { input }) });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/repos/:id/file/difftool', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const repoId = req.params.id;
    const root = registry.rootOf(repoId);
    if (!root) return reply.code(404).send({ error: 'Unknown repository.' });
    if (!gate(repoId, reply)) return reply;
    try {
      if (!isObj(req.body)) return reply.code(400).send({ error: 'Invalid request.' });
      const { sha, path, oldPath } = req.body;
      if (typeof path !== 'string') return reply.code(400).send({ error: 'Missing path.' });
      if (oldPath !== undefined && typeof oldPath !== 'string') return reply.code(400).send({ error: 'Invalid request.' });
      safeRepoPath(root, path);
      if (oldPath !== undefined) safeRepoPath(root, oldPath);
      if (typeof sha !== 'string' || !SHA.test(sha)) return reply.code(400).send({ error: 'Invalid commit.' });
      const commit = await quiet(root, repoId, ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]);
      if (commit.code !== 0 || commit.stdout.trim() !== sha) return reply.code(404).send({ error: 'That commit was not found.' });

      // Needs diff.tool or merge.tool from the user's own git config (ErrorMessage-NoDiffToolSet).
      let configured = false;
      for (const key of ['diff.tool', 'merge.tool']) {
        const r = await quiet(root, repoId, ['config', '--get', key]);
        if (r.code === 0 && r.stdout.trim() !== '') configured = true;
      }
      if (!configured) return reply.code(409).send({ error: 'There is no diff tool configured in your settings' });

      // The commit against its first parent; a root commit against the empty tree.
      const parent = await quiet(root, repoId, ['rev-parse', '--verify', '-q', '--end-of-options', `${sha}^`]);
      let base = parent.code === 0 ? parent.stdout.trim() : '';
      if (!SHA.test(base)) {
        const empty = await quiet(root, repoId, ['hash-object', '-t', 'tree', '--stdin'], '');
        base = empty.code === 0 ? empty.stdout.trim() : '';
      }
      if (!SHA.test(base)) return reply.code(500).send({ error: 'Failed to open diff tool' });

      // One run per repo while a tool is open.
      if (difftoolBusy.has(repoId)) return reply.code(409).send({ error: 'A diff tool is already open for this repository.' });
      difftoolBusy.add(repoId);
      last.set(repoId, Date.now());
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), DIFFTOOL_TIMEOUT_MS);
      try {
        const res = await runDifftool(['--literal-pathspecs', 'difftool', '--no-prompt', base, sha, '--', path, ...(oldPath !== undefined && oldPath !== path ? [oldPath] : [])], {
          cwd: root,
          repoId,
          input: '',
          timeoutMs: DIFFTOOL_TIMEOUT_MS,
          signal: ctl.signal,
        });
        if (res.code !== 0) return reply.code(500).send({ error: 'Failed to open diff tool' });
        return reply.send({ ok: true });
      } catch {
        return reply.code(500).send({ error: 'Failed to open diff tool' });
      } finally {
        clearTimeout(timer);
        difftoolBusy.delete(repoId);
      }
    } catch (e) {
      return unsafe(reply, e);
    }
  });
}
