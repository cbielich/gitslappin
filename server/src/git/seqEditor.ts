import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * V4: the server-owned GIT_SEQUENCE_EDITOR of an interactive rebase. The command is built from server paths only (node, the bundled script,
 * the todo file this server just wrote); git runs it through its shell, so a path with a quote or a control character fails closed.
 */

/** server/assets/seq-editor.mjs, next to the server sources (the same layout as server/templates). */
export const SEQ_EDITOR_SCRIPT = fileURLToPath(new URL('../../assets/seq-editor.mjs', import.meta.url));

/** `'<node>' '<script>' '<todo>'`, or null when a path holds a single quote or a control character. */
export function buildSeqEditorCommand(execPath: string, script: string, todoPath: string): string | null {
  const parts = [execPath, script, todoPath];
  // eslint-disable-next-line no-control-regex
  if (parts.some((p) => p.includes("'") || /[\u0000-\u001F\u007F]/.test(p))) return null;
  return parts.map((p) => `'${p}'`).join(' ');
}

/** Forward slashes: git's shell on Windows reads a backslash inside single quotes literally, but a forward slash works everywhere. */
const slashes = (p: string): string => (process.platform === 'win32' ? p.replaceAll('\\', '/') : p);

/** Writes the todo (lines only hold fixed verbs and full hex shas) as `<dataDir>/rebase-todo/<random>.todo`: `wx`, mode 0600, 144 random bits. */
export async function writeTodoFile(dataDir: string, lines: string[]): Promise<{ path: string; command: string } | null> {
  const dir = join(dataDir, 'rebase-todo');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomBytes(18).toString('base64url')}.todo`);
  const command = buildSeqEditorCommand(slashes(process.execPath), slashes(SEQ_EDITOR_SCRIPT), slashes(path));
  if (!command) return null;
  await writeFile(path, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  return { path, command };
}

/** The server's own scratch file (never user data): removed once git has read it. */
export async function removeTodoFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* already gone */
  }
}
