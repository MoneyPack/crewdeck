import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBrowserBridge } from '../electron/services/browserBridge';

const get = (url: string, token?: string) => fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test('bridge auth, rotation grace, and rate limiting', async () => {
  const h = await startBrowserBridge();
  try {
    const t0 = h.token;
    assert.equal((await get(`${h.url}/state`, t0)).status, 200);
    assert.notEqual((await get(`${h.url}/state`)).status, 200);
    assert.notEqual((await get(`${h.url}/state`, 'bad')).status, 200);

    let rotated: unknown;
    h.onRotate((t: string) => (rotated = t));
    h.rotate();
    const t1 = h.token;
    assert.notEqual(t1, t0);
    assert.equal(rotated, t1);
    assert.equal((await get(`${h.url}/state`, t0)).status, 200, 'old token in grace');
    assert.equal((await get(`${h.url}/state`, t1)).status, 200);

    const codes = await Promise.all(
      Array.from({ length: 150 }, () => get(`${h.url}/health`, t1).then((r) => r.status)),
    );
    assert.ok(codes.includes(429), 'expected 429 after burst');
  } finally {
    await h.close();
  }
});
