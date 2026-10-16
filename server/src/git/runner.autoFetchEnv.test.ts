import { describe, expect, it } from 'vitest';
import { ENV_OVERRIDE_KEYS, runGit, type ExecFileFn } from './runner';

/*
 * V2 runner env override. ENV_OVERRIDE_KEYS (runner.ts) gains exactly four fixed keys for the auto-fetch no-prompt environment:
 *   GCM_INTERACTIVE, GIT_ASKPASS, SSH_ASKPASS, SSH_ASKPASS_REQUIRE
 * on top of the existing GIT_EDITOR, GIT_SEQUENCE_EDITOR, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_AUTHOR_DATE, GIT_MERGE_AUTOEDIT.
 * runGit copies only allowlisted keys with string values; anything else in `opts.env` is ignored.
 */

async function envSeen(override: Record<string, unknown>, base: Record<string, string | undefined> = {}): Promise<Record<string, string | undefined>> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    let seen: Record<string, string | undefined> = {};
    const fake: ExecFileFn = (_f, _a, o, cb) => {
      seen = { ...(o.env as Record<string, string | undefined>) };
      cb(null, '', '');
    };
    await runGit(['fetch', '--all'], { cwd: '.', env: override as never }, fake);
    return seen;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('ENV_OVERRIDE_KEYS', () => {
  it('contains the four no-prompt keys and the six existing ones, nothing else', () => {
    expect([...ENV_OVERRIDE_KEYS].sort()).toEqual(
      ['GCM_INTERACTIVE', 'GIT_ASKPASS', 'GIT_AUTHOR_DATE', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_EDITOR', 'GIT_MERGE_AUTOEDIT', 'GIT_SEQUENCE_EDITOR', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'].sort(),
    );
  });
});

describe('runGit env override', () => {
  it('applies the four no-prompt values to the child, replacing what the parent had', async () => {
    const env = await envSeen(
      { GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'C:/data/askpass.cmd', SSH_ASKPASS: 'C:/data/askpass.cmd', SSH_ASKPASS_REQUIRE: 'force' },
      { GCM_INTERACTIVE: 'always', GIT_ASKPASS: 'parent-askpass', SSH_ASKPASS: 'parent-ssh-askpass', SSH_ASKPASS_REQUIRE: 'never' },
    );
    expect(env.GCM_INTERACTIVE).toBe('never');
    expect(env.GIT_ASKPASS).toBe('C:/data/askpass.cmd');
    expect(env.SSH_ASKPASS).toBe('C:/data/askpass.cmd');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
  });

  it('without an override the parent values pass through unchanged (a user-started fetch keeps the credential window)', async () => {
    const env = await envSeen({}, { GCM_INTERACTIVE: undefined, GIT_ASKPASS: 'parent-askpass', SSH_ASKPASS: 'parent-ssh-askpass', SSH_ASKPASS_REQUIRE: undefined });
    expect(env.GIT_ASKPASS).toBe('parent-askpass');
    expect(env.SSH_ASKPASS).toBe('parent-ssh-askpass');
    expect(env.GCM_INTERACTIVE).toBeUndefined();
    expect(env.SSH_ASKPASS_REQUIRE).toBeUndefined();
  });

  it('keys outside the allowlist are ignored (no repo redirect, no preload, no config injection)', async () => {
    const env = await envSeen(
      {
        GCM_INTERACTIVE: 'never',
        GIT_DIR: '/elsewhere/.git',
        GIT_WORK_TREE: '/elsewhere',
        GIT_SSH_COMMAND: 'evil',
        GIT_EXTERNAL_DIFF: 'evil',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.sshCommand',
        GIT_CONFIG_VALUE_0: 'evil',
        LD_PRELOAD: '/x.so',
        PATH: '/evil',
        EVIL: 'x',
      },
      { GIT_DIR: undefined, GIT_SSH_COMMAND: undefined, GIT_EXTERNAL_DIFF: undefined, LD_PRELOAD: undefined, EVIL: undefined },
    );
    expect(env.GCM_INTERACTIVE).toBe('never'); // the override path ran
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'LD_PRELOAD', 'EVIL']) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.PATH).not.toBe('/evil');
  });

  it('non-string values are ignored', async () => {
    const env = await envSeen({ GCM_INTERACTIVE: 1, GIT_ASKPASS: { x: 1 }, SSH_ASKPASS: null, SSH_ASKPASS_REQUIRE: ['force'] }, { GCM_INTERACTIVE: 'parent', GIT_ASKPASS: 'parent', SSH_ASKPASS: 'parent', SSH_ASKPASS_REQUIRE: 'parent' });
    expect(env.GCM_INTERACTIVE).toBe('parent');
    expect(env.GIT_ASKPASS).toBe('parent');
    expect(env.SSH_ASKPASS).toBe('parent');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('parent');
  });
});
