import { describe, expect, it } from 'vitest';
import { identiconCacheSize, identiconUri } from './identicon';

describe('identicon cache', () => {
  it('stays bounded at 2000 entries', () => {
    for (let i = 0; i < 2600; i++) identiconUri(`user${i}@example.com`);
    expect(identiconCacheSize()).toBe(2000);
    expect(identiconUri('user2599@example.com')).toContain('data:image/svg+xml');
  });
});
