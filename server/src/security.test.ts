import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { isAllowedHost, isAllowedOrigin, isApiPath, isUncOrDevicePath, isValidToken } from './security';
import { repoIdFor } from './state/registry';

describe('security checks', () => {
  it('accepts only 127.0.0.1/localhost with the right port as Host', () => {
    expect(isAllowedHost('127.0.0.1:4518', 4518)).toBe(true);
    expect(isAllowedHost('localhost:4518', 4518)).toBe(true);
    expect(isAllowedHost('127.0.0.1:1', 4518)).toBe(false);
    expect(isAllowedHost('evil.com:4518', 4518)).toBe(false);
    expect(isAllowedHost('127.0.0.1', 4518)).toBe(false);
    expect(isAllowedHost(undefined, 4518)).toBe(false);
  });

  it('allows a missing Origin but rejects foreign ones', () => {
    expect(isAllowedOrigin(undefined, 4518)).toBe(true);
    expect(isAllowedOrigin('http://localhost:4518', 4518)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4518', 4518)).toBe(true);
    expect(isAllowedOrigin('http://evil.com', 4518)).toBe(false);
    expect(isAllowedOrigin('http://localhost:9999', 4518)).toBe(false);
    expect(isAllowedOrigin('null', 4518)).toBe(false);
  });

  it('compares tokens exactly', () => {
    expect(isValidToken('abc', 'abc')).toBe(true);
    expect(isValidToken('abd', 'abc')).toBe(false);
    expect(isValidToken('ab', 'abc')).toBe(false);
    expect(isValidToken(undefined, 'abc')).toBe(false);
  });

  it('detects api paths', () => {
    expect(isApiPath('/api/recent?x=1')).toBe(true);
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/apix')).toBe(false);
  });
});

describe('app hooks', () => {
  const port = 4999;
  const make = () =>
    buildApp({
      port,
      token: 'tok',
      dataDir: mkdtempSync(join(tmpdir(), 'gitslappin-unit-')),
      clientDist: join(tmpdir(), 'gitslappin-no-such-dist'),
      noOpen: true,
    });

  it('an encoded /api path does not skip the token (403 without it)', async () => {
    const app = await make();
    const host = `127.0.0.1:${port}`;
    for (const url of ['/%61pi/recent', '/%2561pi/recent', '/%252561pi/recent', '/api%2Frecent', '/%61pi/fs/list']) {
      expect((await app.inject({ method: 'GET', url, headers: { host } })).statusCode, url).toBe(403);
    }
    // A malformed escape is refused by Fastify's URL parser (400) before the hook runs; either way it is never served.
    expect([400, 403]).toContain((await app.inject({ method: 'GET', url: '/%zz/api', headers: { host } })).statusCode);
  });

  it('rejects api calls without token, bad host, bad origin; allows valid', async () => {
    const app = await make();
    const host = `127.0.0.1:${port}`;
    const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/recent', headers });
    expect((await get({ host })).statusCode).toBe(403);
    expect((await get({ host: 'evil.com', 'x-gitslappin-token': 'tok' })).statusCode).toBe(403);
    expect((await get({ host, origin: 'http://evil.com', 'x-gitslappin-token': 'tok' })).statusCode).toBe(403);
    expect((await get({ host, 'x-gitslappin-token': 'tok' })).statusCode).toBe(200);
  });

  it('sets security headers on every response and no-store only on the API', async () => {
    const app = await make();
    const host = `127.0.0.1:${port}`;
    const api = await app.inject({ method: 'GET', url: '/api/recent', headers: { host, 'x-gitslappin-token': 'tok' } });
    expect(api.headers['referrer-policy']).toBe('no-referrer');
    expect(api.headers['x-content-type-options']).toBe('nosniff');
    expect(api.headers['cache-control']).toBe('no-store');
    const denied = await app.inject({ method: 'GET', url: '/api/recent', headers: { host } });
    expect(denied.headers['x-content-type-options']).toBe('nosniff');
    const other = await app.inject({ method: 'GET', url: '/index.html', headers: { host } });
    expect(other.headers['referrer-policy']).toBe('no-referrer');
    expect(other.headers['cache-control']).toBeUndefined();
  });

  it('error handler: a thrown error is a generic 500 without its text; a 4xx keeps its status with a scrubbed message', async () => {
    const app = await make();
    app.get('/api/boom', async () => {
      throw new Error('fatal: https://u:pw@host/x.git failed');
    });
    app.get('/api/bad', async () => {
      throw Object.assign(new Error('bad https://u:pw@host/x'), { statusCode: 400 });
    });
    const headers = { host: `127.0.0.1:${port}`, 'x-gitslappin-token': 'tok' };
    const boom = await app.inject({ method: 'GET', url: '/api/boom', headers });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toEqual({ error: 'Internal server error.' });
    const bad = await app.inject({ method: 'GET', url: '/api/bad', headers });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'bad https://***@host/x' });
  });

  it('refuses UNC and device paths when opening a repo', async () => {
    const app = await make();
    const headers = { host: `127.0.0.1:${port}`, 'x-gitslappin-token': 'tok' };
    for (const path of [String.raw`\\server\share`, String.raw`\\?\C:\x`, String.raw`\\.\pipe\x`, '//server/share']) {
      const res = await app.inject({ method: 'POST', url: '/api/repos/open', headers, payload: { path } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/UNC and device paths/);
    }
  });

  it('drops tabs whose id does not match their root or that are UNC paths', async () => {
    const app = await make();
    const headers = { host: `127.0.0.1:${port}`, 'x-gitslappin-token': 'tok' };
    const tabs = [
      { id: 'deadbeef0000', root: tmpdir(), name: 'x' },
      { id: repoIdFor(String.raw`\\server\share\r`), root: String.raw`\\server\share\r`, name: 'r' },
    ];
    const put = await app.inject({ method: 'PUT', url: '/api/tabs', headers, payload: { tabs, activeId: 'deadbeef0000' } });
    expect(put.statusCode).toBe(200);
    const got = await app.inject({ method: 'GET', url: '/api/tabs', headers });
    expect(got.json()).toEqual({ tabs: [], activeId: null });
  });
});

describe('isUncOrDevicePath', () => {
  it('detects UNC and device paths only', () => {
    expect(isUncOrDevicePath(String.raw`\\server\share`)).toBe(true);
    expect(isUncOrDevicePath(String.raw`\\?\C:\x`)).toBe(true);
    expect(isUncOrDevicePath(String.raw`\\.\COM1`)).toBe(true);
    expect(isUncOrDevicePath('//server/share')).toBe(true);
    expect(isUncOrDevicePath(String.raw`C:\repos\x`)).toBe(false);
    expect(isUncOrDevicePath('/tmp/x')).toBe(false);
  });
});
