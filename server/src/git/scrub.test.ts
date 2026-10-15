import { describe, expect, it } from 'vitest';
import { childEnv } from './runner';
import { scrubSecrets } from './scrub';

/*
 * Contract the builder must export from server/src/git/scrub.ts:
 *   scrubSecrets(text: string): string
 *     - /(:\/\/)[^\/\s@]+@/g -> '$1***@'   (user:pass@ and user@ in any scheme)
 *     - lines carrying an `Authorization:` header or a `Bearer <token>` have the secret removed
 *     - never throws, returns '' for ''
 * Applied by the remote routes to stdout, stderr, {error} and GET /remotes URLs (design: Security audit, Scrubbing).
 *
 * childEnv (server/src/git/runner.ts) must, per the phase 7 amendment, keep GIT_SSH, GIT_SSH_COMMAND, GIT_SSH_VARIANT,
 * GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL, and strip GIT_DIR, GIT_WORK_TREE, request-influenced GIT_CONFIG_* keys,
 * GIT_EXTERNAL_DIFF and GITSLAPPIN_TOKEN. Fails today: only GITSLAPPIN_TOKEN is stripped.
 */

describe('scrubSecrets', () => {
  it('hides user:pass in an https URL', () => {
    expect(scrubSecrets('fatal: unable to access https://alice:hunter2@example.com/x.git/: nope')).toBe(
      'fatal: unable to access https://***@example.com/x.git/: nope',
    );
  });

  it('hides a bare user (ssh) and keeps the rest of the URL', () => {
    expect(scrubSecrets('From ssh://git@example.com:22/team/p.git')).toBe('From ssh://***@example.com:22/team/p.git');
  });

  it('hides every URL on every line (stdout and stderr style text)', () => {
    const out = scrubSecrets('a https://u1:p1@h1/x\nb http://u2:p2@h2/y and https://u3:p3@h3/z\n');
    expect(out).toBe('a https://***@h1/x\nb http://***@h2/y and https://***@h3/z\n');
    for (const secret of ['u1', 'p1', 'u2', 'p2', 'u3', 'p3']) expect(out).not.toContain(secret);
  });

  it('keeps a password that contains a colon, percent-escapes or a dot out of the text', () => {
    const out = scrubSecrets('remote: https://bot:pa:ss%40w.rd@git.example.com/r.git');
    expect(out).not.toContain('pa:ss');
    expect(out).not.toContain('w.rd');
    expect(out).toContain('https://***@git.example.com/r.git');
  });

  it('leaves URLs without user info alone, including an @ later in the path', () => {
    for (const text of ['https://example.com/team/p.git', 'file:///C:/Users/x/origin.git', 'https://host/a@b', 'plain text with a@b.com']) {
      expect(scrubSecrets(text)).toBe(text);
    }
  });

  it('redacts Authorization and Bearer values', () => {
    const out = scrubSecrets('> GET /x\nAuthorization: Basic dXNlcjpwYXNz\n< token Bearer abc.DEF-123 ok\nauthorization: Bearer zzz999\n');
    expect(out).not.toContain('dXNlcjpwYXNz');
    expect(out).not.toContain('abc.DEF-123');
    expect(out).not.toContain('zzz999');
    expect(out).toContain('> GET /x');
  });

  it('hides a password that contains an @ (greedy to the last @) or a slash', () => {
    for (const [text, rest] of [
      ['https://u:p@ss@host/x.git', 'https://***@host/x.git'],
      ['https://u:p/ss@host/x.git', 'https://***@host/x.git'],
    ] as const) {
      const out = scrubSecrets(`fatal: ${text}`);
      expect(out).toBe(`fatal: ${rest}`);
      expect(out).not.toMatch(/ss/);
    }
    expect(scrubSecrets('https://host:8080/a@b')).toBe('https://host:8080/a@b');
  });

  it('hides token query values', () => {
    const out = scrubSecrets('GET https://h/x?a=1&private_token=abc123&b=2 and ?access_token=zz9 ?Password=pw1');
    expect(out).toBe('GET https://h/x?a=1&private_token=***&b=2 and ?access_token=*** ?Password=***');
    expect(scrubSecrets('https://h/x?tokenizer=keep')).toBe('https://h/x?tokenizer=keep');
  });

  it('is idempotent and total', () => {
    const once = scrubSecrets('https://alice:hunter2@example.com/x.git');
    expect(scrubSecrets(once)).toBe(once);
    expect(scrubSecrets('')).toBe('');
  });
});

describe('childEnv for remote operations', () => {
  const KEEP = ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'];
  const STRIP = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_EXTERNAL_DIFF',
    'GITSLAPPIN_TOKEN',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_PARAMETERS',
  ];

  function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
    const before: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) before[k] = process.env[k];
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("keeps the user's GIT_SSH, GIT_SSH_COMMAND, GIT_SSH_VARIANT and the two isolation vars", () => {
    const vars = {
      GIT_SSH: 'C:/tools/plink.exe',
      GIT_SSH_COMMAND: 'plink -batch',
      GIT_SSH_VARIANT: 'putty',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: 'C:/tmp/empty.gitconfig',
    };
    const env = withEnv(vars, () => childEnv());
    for (const k of KEEP) expect(env[k], k).toBe(vars[k as keyof typeof vars]);
  });

  it('strips GIT_DIR, GIT_WORK_TREE, GIT_EXTERNAL_DIFF, GITSLAPPIN_TOKEN and the request-influenced GIT_CONFIG_* keys', () => {
    const vars = Object.fromEntries(STRIP.map((k) => [k, 'x']));
    const env = withEnv(vars, () => childEnv());
    for (const k of STRIP) expect(env[k], k).toBeUndefined();
  });

  it('keeps GIT_TERMINAL_PROMPT=0 and never injects GIT_SSH_COMMAND or a GCM override', () => {
    const env = withEnv({ GIT_SSH_COMMAND: '', GCM_INTERACTIVE: '' }, () => {
      delete process.env.GIT_SSH_COMMAND;
      delete process.env.GCM_INTERACTIVE;
      return childEnv();
    });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GCM_INTERACTIVE).toBeUndefined();
  });
});
