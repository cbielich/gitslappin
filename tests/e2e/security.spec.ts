import { expect, test } from '@playwright/test';
import { TEST_TOKEN } from './helpers/repo';

test('API without token is rejected with 403', async ({ request }) => {
  const res = await request.get('/api/recent');
  expect(res.status()).toBe(403);
});

test('API with wrong token is rejected with 403', async ({ request }) => {
  const res = await request.get('/api/recent', { headers: { 'X-GitSlappin-Token': 'nope' } });
  expect(res.status()).toBe(403);
});

test('API with token succeeds', async ({ request }) => {
  const res = await request.get('/api/recent', { headers: { 'X-GitSlappin-Token': TEST_TOKEN } });
  expect(res.status()).toBe(200);
});

test('wrong Origin is rejected with 403', async ({ request }) => {
  const res = await request.get('/api/recent', {
    headers: { 'X-GitSlappin-Token': TEST_TOKEN, Origin: 'http://evil.example' },
  });
  expect(res.status()).toBe(403);
});

test('static files need no token', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
});
