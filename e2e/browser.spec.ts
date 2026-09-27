import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

type Bridge = { url: string; token: string };
type Reply = { status: number; body: any };

type RequestOpts = { token?: string | null; origin?: string; body?: unknown };

function request(bridge: Bridge, method: string, route: string, opts: RequestOpts = {}): Promise<Reply> {
  const target = new URL(route, bridge.url);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? bridge.token : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.origin) headers.origin = opts.origin;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise<Reply>((resolve, reject) => {
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method, headers, timeout: 30000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: any = raw;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('bridge timeout ' + route)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function refFor(snapshot: string, role: string, name: string): string {
  for (const line of snapshot.split(/\r?\n/)) {
    const m = /@(e\d+)\s+(\S+)(?:\s+"([^"]*)")?/.exec(line);
    if (m && m[2] === role && (m[3] ?? '').includes(name)) return m[1];
  }
  throw new Error(`no ${role} "${name}" in snapshot:\n${snapshot}`);
}

const FORM = [
  '<!doctype html><title>crewdeck form</title>',
  '<label>Name <input id="n" aria-label="Name"></label>',
  '<button id="g" type="button">Greet</button>',
  '<p id="out"></p>',
  "<script>document.getElementById('g').addEventListener('click',function(){document.getElementById('out').textContent='hello '+document.getElementById('n').value;});</script>",
].join('');
const FORM_URL = `data:text/html,${encodeURIComponent(FORM)}`;

test('browser pane is driven over the authenticated bridge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-browser-'));
  const userData = path.join(root, 'userData');
  const project = path.join(root, 'project');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const exe = process.env.CREWDECK_E2E_EXE;
  const app = await electron.launch({
    ...(exe ? { executablePath: exe } : { args: [path.resolve('dist-electron/main.cjs')] }),
    env: {
      ...process.env,
      CREWDECK_USER_DATA: userData,
      CREWDECK_TEST_PROJECT: project,
      CREWDECK_E2E_BRIDGE: '1',
    } as Record<string, string>,
  });

  try {
    const win = await test.step('open project and browser pane', async () => {
      const w = await app.firstWindow();
      await expect(w.locator('.toolbar .title')).toHaveText('crewdeck');
      await w.locator('button.project').click();
      await expect(w.locator('button.project')).toContainText('project');
      await w.getByRole('button', { name: 'Browser', exact: true }).click();
      await expect(w.getByLabel('Address')).toBeVisible();
      return w;
    });

    const bridge = await test.step('bridge is published', async () => {
      let found: Bridge | null = null;
      await expect
        .poll(async () => {
          found = await app.evaluate(() => (globalThis as any).__crewdeckBridge ?? null);
          return Boolean(found && found.url && found.token);
        })
        .toBe(true);
      const b = found as unknown as Bridge;
      expect(new URL(b.url).hostname).toBe('127.0.0.1');
      return b;
    });

    await test.step('bridge guards', async () => {
      expect((await request(bridge, 'GET', '/state', { token: null })).status).toBe(401);
      expect((await request(bridge, 'GET', '/state', { token: 'wrong' })).status).toBe(401);
      expect((await request(bridge, 'GET', '/state', { origin: 'https://evil.example' })).status).toBe(403);
      expect((await request(bridge, 'GET', '/nope')).status).toBe(404);
      expect((await request(bridge, 'GET', '/run')).status).toBe(405);
      expect(
        (await request(bridge, 'POST', '/run', { body: { command: { action: 'bogus' }, from: 'e2e' } })).status,
      ).toBe(400);
    });

    const run = async (command: Record<string, unknown>) =>
      test.step(`run ${String(command.action)}`, async () => {
        const reply = await request(bridge, 'POST', '/run', { body: { command, from: 'e2e' } });
        console.log(`[e2e] ${String(command.action)} ->`, JSON.stringify(reply.body).slice(0, 600));
        if (reply.body?.error) console.log('[e2e] error', String(reply.body.error));
        expect(reply.status).toBe(200);
        expect(reply.body.ok).toBe(true);
        return reply.body;
      });

    const opened = await run({ action: 'open', url: FORM_URL });
    expect(opened.title).toBe('crewdeck form');

    const snap = await run({ action: 'snapshot', interactiveOnly: true });
    const nameRef = refFor(snap.text, 'textbox', 'Name');
    const greetRef = refFor(snap.text, 'button', 'Greet');

    await run({ action: 'fill', ref: nameRef, text: 'crew' });
    await run({ action: 'click', ref: greetRef });
    const waited = await run({ action: 'wait', text: 'hello crew', ref: null, timeoutMs: 5000 });
    expect(waited.text).toContain('hello crew');

    const shot = await run({ action: 'screenshot', fullPage: false, annotate: true });
    console.log('[e2e] via', shot.via);
    expect(shot.via).toBe('offscreen');
    expect(fs.existsSync(shot.screenshotPath)).toBe(true);
    expect(fs.statSync(shot.screenshotPath).size).toBeGreaterThan(100);

    await test.step('state and address bar', async () => {
      const state = await request(bridge, 'GET', '/state');
      expect(state.status).toBe(200);
      expect(state.body.ok).toBe(true);
      expect(state.body.state.title).toBe('crewdeck form');
      await expect(win.getByLabel('Address')).toHaveValue(/^data:text\/html/);
    });

    await test.step('routing log shows browser entries', async () => {
      await win.locator('.log-toggle[title^="Routing log"]').click();
      await expect(win.getByRole('complementary', { name: 'Routing log' })).toBeVisible();
      const entries = win.locator('li.route.browser');
      await expect(entries.first()).toBeVisible();
      const before = await entries.count();
      await run({ action: 'status' });
      await expect(entries).toHaveCount(before + 1);
    });
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
