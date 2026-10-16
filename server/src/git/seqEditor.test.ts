import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSeqEditorCommand } from './seqEditor';

/*
 * V4 contract (build-notes "Editor security" + audit security item 5):
 *   server/src/git/seqEditor.ts   buildSeqEditorCommand(execPath: string, script: string, todoPath: string): string | null
 *     -> `'<execPath>' '<script>' '<todoPath>'` (each path in single quotes, nothing else), or null (fail closed) when ANY of the three
 *        contains a single quote or a control character (code < 0x20 or 0x7f). Spaces are fine.
 *   server/assets/seq-editor.mjs  invoked as `node seq-editor.mjs <source> <target>` (git appends <target>, the real todo file, as the last argument).
 *     - <target> must have the base name `git-rebase-todo`, else exit != 0 and the target is untouched.
 *     - <source> must resolve (realpath) to a file directly inside a directory named `rebase-todo`; a source anywhere else, or one reached
 *       through a link/junction that leads outside, exits != 0 and the target is untouched.
 *     - otherwise the source bytes are copied to the target byte for byte and the exit code is 0.
 *   The allowed directory is derived from the source path itself (its real parent must be named `rebase-todo`); the test author does not know
 *   how the builder passes <dataDir> (UNVERIFIED), so only these observable cases are asserted.
 * All fixtures are mkdtemp folders under os.tmpdir()/gitslappin-tests. Nothing is deleted.
 */

const ROOT = join(tmpdir(), 'gitslappin-tests');
function fresh(prefix: string): string {
  mkdirSync(ROOT, { recursive: true });
  const dir = mkdtempSync(join(ROOT, `${prefix}-`));
  if (!dir.startsWith(ROOT) || readdirSync(dir).length !== 0) throw new Error(`Test dir is not fresh and empty: ${dir}`);
  return dir;
}
const SCRIPT = fileURLToPath(new URL('../../assets/seq-editor.mjs', import.meta.url));
const run = (source: string, target: string) => spawnSync(process.execPath, [SCRIPT, source, target], { encoding: 'utf8', windowsHide: true });

describe('buildSeqEditorCommand', () => {
  it('quotes the three paths with single quotes, in order', () => {
    expect(buildSeqEditorCommand('C:/node/node.exe', 'C:/app/assets/seq-editor.mjs', 'C:/data/rebase-todo/abc.todo')).toBe("'C:/node/node.exe' 'C:/app/assets/seq-editor.mjs' 'C:/data/rebase-todo/abc.todo'");
  });
  it('spaces in a path are kept inside the quotes', () => {
    expect(buildSeqEditorCommand('/usr/bin/node', '/opt/my app/seq-editor.mjs', '/data dir/rebase-todo/x.todo')).toBe("'/usr/bin/node' '/opt/my app/seq-editor.mjs' '/data dir/rebase-todo/x.todo'");
  });
  it('fails closed (null) when a path holds a single quote', () => {
    expect(buildSeqEditorCommand("/usr/bin/node", '/opt/a.mjs', "/data/it's/x.todo")).toBeNull();
    expect(buildSeqEditorCommand("/usr/b'in/node", '/opt/a.mjs', '/data/x.todo')).toBeNull();
    expect(buildSeqEditorCommand('/usr/bin/node', "/opt/'a.mjs", '/data/x.todo')).toBeNull();
  });
  it('fails closed (null) on a newline, a NUL, a tab or another control character', () => {
    for (const bad of ['\n', '\r', '\0', '\t', '\x1b', '\x7f']) {
      expect(buildSeqEditorCommand('/usr/bin/node', '/opt/a.mjs', `/data/x${bad}y.todo`), JSON.stringify(bad)).toBeNull();
      expect(buildSeqEditorCommand(`/usr/bin/no${bad}de`, '/opt/a.mjs', '/data/x.todo'), JSON.stringify(bad)).toBeNull();
    }
  });
  it('shell metacharacters other than the quote are harmless inside single quotes and are accepted', () => {
    expect(buildSeqEditorCommand('/usr/bin/node', '/opt/a.mjs', '/data/$(x);&y/x.todo')).toBe("'/usr/bin/node' '/opt/a.mjs' '/data/$(x);&y/x.todo'");
  });
});

describe('seq-editor.mjs', () => {
  const TODO = 'pick aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\nfixup bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n';

  it('copies the source bytes to git-rebase-todo, even with spaces in the data dir', () => {
    const data = fresh('seqed data with spaces');
    mkdirSync(join(data, 'rebase-todo'));
    const source = join(data, 'rebase-todo', 'ok.todo');
    writeFileSync(source, TODO);
    const target = join(fresh('seqed-target'), 'git-rebase-todo');
    writeFileSync(target, 'pick 0000000000000000000000000000000000000000\n');
    const r = run(source, target);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(target).equals(Buffer.from(TODO))).toBe(true);
  });

  it('refuses a source outside a rebase-todo folder; the target stays as git wrote it', () => {
    const data = fresh('seqed-outside');
    const source = join(data, 'elsewhere.todo');
    writeFileSync(source, 'exec calc.exe\n');
    const target = join(fresh('seqed-target'), 'git-rebase-todo');
    writeFileSync(target, 'original\n');
    const r = run(source, target);
    expect(r.status).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });

  it('refuses a source that leaves rebase-todo through a link (realpath is outside)', () => {
    const data = fresh('seqed-link');
    const outside = join(data, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'evil.todo'), 'exec calc.exe\n');
    mkdirSync(join(data, 'rebase-todo'));
    // a directory junction needs no privilege on Windows; on other systems it is a plain symlink
    symlinkSync(outside, join(data, 'rebase-todo', 'link'), 'junction');
    const target = join(fresh('seqed-target'), 'git-rebase-todo');
    writeFileSync(target, 'original\n');
    const r = run(join(data, 'rebase-todo', 'link', 'evil.todo'), target);
    expect(r.status).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });

  it('refuses a target that is not named git-rebase-todo (it must never overwrite another file)', () => {
    const data = fresh('seqed-target-name');
    mkdirSync(join(data, 'rebase-todo'));
    const source = join(data, 'rebase-todo', 'ok.todo');
    writeFileSync(source, TODO);
    const victim = join(fresh('seqed-victim'), 'important.txt');
    writeFileSync(victim, 'keep me\n');
    const r = run(source, victim);
    expect(r.status).not.toBe(0);
    expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
  });

  it('refuses a missing source (exit != 0, target untouched)', () => {
    const data = fresh('seqed-missing');
    mkdirSync(join(data, 'rebase-todo'));
    const target = join(fresh('seqed-target'), 'git-rebase-todo');
    writeFileSync(target, 'original\n');
    const r = run(join(data, 'rebase-todo', 'nope.todo'), target);
    expect(r.status).not.toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });
});
