import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { OpenRepoRequest, RepoInfo, TabsState } from '@gitslappin/shared';
import { runGit } from '../git/runner';
import { forgetRepo } from '../git/undo';
import { mapOpenPath, type PathPair } from '../pathMap';
import { isUnderRoots } from '../repoRoots';
import { isUncOrDevicePath } from '../security';
import type { JsonStore } from '../state/jsonStore';
import { RepoRegistry, repoIdFor, repoInfoFor } from '../state/registry';

const MAX_RECENT = 20;

export type OpenRepoAt = (input: string) => Promise<{ info: RepoInfo } | { error: string; status: number }>;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isRepoInfo(v: unknown): v is RepoInfo {
  const r = v as RepoInfo;
  return !!r && typeof r.id === 'string' && typeof r.root === 'string' && typeof r.name === 'string';
}

/**
 * Re-validates a tab from the client or from tabs.json: rebuilds it from its root, requires the id
 * to match the root, and asks git for the top level again. Returns null for anything invalid.
 */
async function validateTab(v: unknown, roots: string[]): Promise<RepoInfo | null> {
  if (!isRepoInfo(v) || isUncOrDevicePath(v.root)) return null;
  const root = resolve(v.root);
  if (v.id !== repoIdFor(root) || !isDir(root) || !isUnderRoots(root, roots)) return null;
  const res = await runGit(['rev-parse', '--show-toplevel'], { cwd: root });
  if (res.code !== 0 || !res.stdout.trim()) return null;
  const info = repoInfoFor(resolve(res.stdout.trim()));
  return info.id === v.id && isUnderRoots(info.root, roots) ? info : null;
}

async function validateTabs(list: unknown[], registry: RepoRegistry, roots: string[]): Promise<RepoInfo[]> {
  const out: RepoInfo[] = [];
  // Repos already validated during this server run (open or restore) are not re-checked with git.
  const check = (t: unknown) =>
    isRepoInfo(t) && registry.rootOf(t.id) === t.root ? Promise.resolve<RepoInfo | null>(repoInfoFor(t.root)) : validateTab(t, roots);
  for (const info of await Promise.all(list.map(check))) {
    if (info && !out.some((o) => o.id === info.id)) out.push(info);
  }
  return out;
}

export function registerRepoRoutes(
  app: FastifyInstance,
  registry: RepoRegistry,
  recent: JsonStore<RepoInfo[]>,
  tabs: JsonStore<TabsState>,
  roots: string[] = [],
  pathMap: PathPair[] = [],
): OpenRepoAt {
  const outside = 'That folder is outside the folders GitSlappin may open.';
  let tabsQueue: Promise<void> = Promise.resolve();

  /** The checks and bookkeeping of "open": existence, roots, git top level, registry and recent list. `input` is already mapped and not UNC. */
  async function openRepoAt(input: string): Promise<{ info: RepoInfo } | { error: string; status: number }> {
    const path = resolve(input);
    if (!isUnderRoots(path, roots)) return { status: 400, error: outside };
    if (!existsSync(path)) return { status: 400, error: `Path does not exist: ${path}` };
    if (!isDir(path)) return { status: 400, error: `Not a folder: ${path}` };

    const res = await runGit(['rev-parse', '--show-toplevel'], { cwd: path });
    if (res.code === -1) return { status: 500, error: `Could not run git: ${res.stderr.trim()}` };
    if (res.code !== 0 || !res.stdout.trim()) return { status: 400, error: `Not a git repository: ${path}` };
    const info = repoInfoFor(resolve(res.stdout.trim()));
    if (!isUnderRoots(info.root, roots)) return { status: 400, error: outside };
    registry.register(info);
    const list = [info, ...recent.read().filter((r) => r.id !== info.id)].slice(0, MAX_RECENT);
    recent.write(list);
    return { info };
  }

  app.post('/api/repos/open', async (req, reply) => {
    const raw = (req.body as Partial<OpenRepoRequest> | null)?.path;
    const typed = typeof raw === 'string' ? raw.trim().replace(/^"(.*)"$/, '$1') : '';
    if (!typed) return reply.code(400).send({ error: 'Enter a folder path.' });
    const mapped = mapOpenPath(typed, pathMap);
    if ('error' in mapped) return reply.code(400).send({ error: mapped.error });
    const input = mapped.path;
    if (isUncOrDevicePath(input)) {
      return reply.code(400).send({ error: 'UNC and device paths are not supported. Use a local folder.' });
    }
    const opened = await openRepoAt(input);
    if ('error' in opened) return reply.code(opened.status).send({ error: opened.error });
    return opened.info;
  });

  app.get('/api/recent', async () => recent.read().filter((r) => isDir(r.root)));

  app.get('/api/tabs', async () => {
    await tabsQueue;
    const state = tabs.read();
    const alive = await validateTabs(Array.isArray(state.tabs) ? state.tabs : [], registry, roots);
    alive.forEach((t) => registry.register(t));
    const activeId = alive.some((t) => t.id === state.activeId) ? state.activeId : (alive[0]?.id ?? null);
    return { tabs: alive, activeId } satisfies TabsState;
  });

  app.put('/api/tabs', async (req, reply) => {
    const body = req.body as Partial<TabsState> | null;
    if (!body || !Array.isArray(body.tabs) || !body.tabs.every(isRepoInfo)) {
      return reply.code(400).send({ error: 'Invalid tabs payload.' });
    }
    // Validation is async: writes run one at a time, in arrival order, and GET waits for them.
    const list = body.tabs;
    const requestedActive = body.activeId;
    tabsQueue = tabsQueue.then(async () => {
      const valid = await validateTabs(list, registry, roots);
      valid.forEach((t) => registry.register(t));
      const activeId = typeof requestedActive === 'string' && valid.some((t) => t.id === requestedActive) ? requestedActive : null;
      // Phase 10: a tab that was open and no longer is has been closed. Its undo journal goes, unless another tab still shows that repo.
      const before = tabs.read().tabs;
      for (const t of Array.isArray(before) ? before : []) {
        if (isRepoInfo(t) && !valid.some((v) => v.id === t.id)) forgetRepo(t.root);
      }
      tabs.write({ tabs: valid, activeId });
    }).catch(() => undefined);
    await tabsQueue;
    return { ok: true };
  });
  return openRepoAt;
}
