import { describe, expect, it } from 'vitest';
import { getCommandLog, recordCommand, scrubArg, setLogToken } from './commandLog';

const e = (args: string[]) => ({ at: 1, args, code: 0, durationMs: 2 });

describe('command log', () => {
  it('seq increases per repo and never repeats; after= returns only newer entries', () => {
    recordCommand('cl-a', e(['one']));
    recordCommand('cl-a', e(['two']));
    recordCommand('cl-b', e(['other']));
    const all = getCommandLog('cl-a');
    expect(all.map((x) => x.args[0])).toEqual(['one', 'two']);
    expect(all[1]!.seq).toBe(all[0]!.seq + 1);
    expect(getCommandLog('cl-a', all[0]!.seq).map((x) => x.args[0])).toEqual(['two']);
    expect(getCommandLog('cl-a', all[1]!.seq)).toEqual([]);
    expect(getCommandLog('cl-b')).toHaveLength(1);
  });

  it('keeps at most 1,000 entries (the newest), and seq keeps counting', () => {
    for (let i = 0; i < 1100; i++) recordCommand('cl-cap', e([`n${i}`]));
    const list = getCommandLog('cl-cap');
    expect(list).toHaveLength(1000);
    expect(list[0]!.args[0]).toBe('n100');
    expect(list[999]!.args[0]).toBe('n1099');
    expect(list[999]!.seq).toBe(1100);
  });

  it('args are scrubbed (URL credentials, Authorization, extraheader, the GitSlappin token) and cut to 500 characters', () => {
    setLogToken('tok-secret-xyz');
    expect(scrubArg('https://user:hunter2@example.com/x.git')).not.toContain('hunter2');
    expect(scrubArg('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(scrubArg('http.https://example.com/.extraheader=AUTHORIZATION: basic QWxhZGRpbg==')).not.toContain('QWxhZGRpbg');
    expect(scrubArg('http.extraheader=X-Key: s3cret')).not.toContain('s3cret');
    expect(scrubArg('a-tok-secret-xyz-b')).toBe('a-***-b');
    expect(scrubArg('z'.repeat(1200))).toHaveLength(500);
    recordCommand('cl-scrub', e(['--grep=' + 'q'.repeat(900), 'tok-secret-xyz']));
    const args = getCommandLog('cl-scrub')[0]!.args;
    expect(args[0]).toHaveLength(500);
    expect(args[1]).toBe('***');
    setLogToken('');
  });
});
