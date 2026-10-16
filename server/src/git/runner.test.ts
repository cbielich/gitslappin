import { describe, expect, it } from 'vitest';
import { getCommandLog } from './commandLog';
import { runExclusive } from './queue';
import { GIT_PATH, buildGitArgs, childEnv, runGit, type ExecFileFn } from './runner';

describe('git runner', () => {
  it('prefixes args with core.quotepath=off and core.fsmonitor=false', () => {
    expect(buildGitArgs(['status', '-s'])).toEqual(['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', 'status', '-s']);
  });

  it('calls execFile with git, an arg array, no shell, and records the call', async () => {
    let captured: { file: string; args: string[]; options: Record<string, unknown> } | undefined;
    const fake: ExecFileFn = (file, args, options, cb) => {
      captured = { file, args, options };
      cb(null, 'out', '');
    };
    const res = await runGit(['rev-parse', '--show-toplevel'], { cwd: 'X', repoId: 'r1' }, fake);
    expect(res).toEqual({ code: 0, stdout: 'out', stderr: '' });
    expect(captured?.file).toBe(GIT_PATH);
    expect(captured?.args).toEqual(['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel']);
    expect(captured?.options.shell).toBeUndefined();
    expect(captured?.options.cwd).toBe('X');
    expect(captured?.options.windowsHide).toBe(true);
    expect((captured?.options.env as Record<string, string>).GIT_TERMINAL_PROMPT).toBe('0');
    expect((captured?.options.env as Record<string, string>).GIT_OPTIONAL_LOCKS).toBe('0');
    const log = getCommandLog('r1');
    expect(log).toHaveLength(1);
    expect(log[0]?.args).toEqual(['rev-parse', '--show-toplevel']);
    expect(log[0]?.code).toBe(0);
  });

  it('strips GITSLAPPIN_TOKEN from the child environment and writes input to stdin', async () => {
    const before = process.env.GITSLAPPIN_TOKEN;
    process.env.GITSLAPPIN_TOKEN = 'secret-token';
    try {
      expect(childEnv().GITSLAPPIN_TOKEN).toBeUndefined();
      expect(childEnv().GIT_TERMINAL_PROMPT).toBe('0');
      let written: unknown;
      let seenEnv: Record<string, string> | undefined;
      const fake: ExecFileFn = (_f, _a, o, cb) => {
        seenEnv = o.env as Record<string, string>;
        cb(null, '', '');
        return { stdin: { on: () => undefined, end: (b: unknown) => (written = b) } };
      };
      await runGit(['commit', '-F', '-'], { cwd: '.', input: 'the message' }, fake);
      expect(written).toBe('the message');
      expect(seenEnv?.GITSLAPPIN_TOKEN).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.GITSLAPPIN_TOKEN;
      else process.env.GITSLAPPIN_TOKEN = before;
    }
  });

  it('maps a non-zero exit to its code', async () => {
    const fake: ExecFileFn = (_f, _a, _o, cb) => cb(Object.assign(new Error('x'), { code: 128 }), '', 'fatal');
    expect(await runGit(['x'], { cwd: '.' }, fake)).toEqual({ code: 128, stdout: '', stderr: 'fatal' });
  });

  it('runExclusive serializes tasks per repo', async () => {
    const order: number[] = [];
    const a = runExclusive('q', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const b = runExclusive('q', async () => {
      order.push(2);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
  });
});
