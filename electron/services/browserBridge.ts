/**
 * Loopback HTTP bridge that lets agents running inside crewdeck terminals drive the
 * embedded browser (via the `crewdeck-browser` CLI or the `crewdeck-mcp` stdio server).
 *
 * Security model:
 *  - binds 127.0.0.1 on a random port; never exposed off-box
 *  - per-session 256-bit bearer token, compared in constant time
 *  - Host header must be the loopback literal (defeats DNS rebinding)
 *  - any request carrying an Origin header is rejected (no browser-originated calls)
 *  - JSON bodies only, capped at 64 KiB; commands go through the same validator as IPC
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseBrowserCommand, type BrowserResult } from '../../shared/browser';
import { browserEngine } from './browserEngine';
import { getDatabase } from './db';

const MAX_BODY_BYTES = 64 * 1024;
const ROTATE_MS = 12 * 60 * 60_000;
const GRACE_MS = ROTATE_MS;
const RATE_PER_SEC = 50;
const RATE_BURST = 100;

export interface BridgeHandle {
  readonly url: string;
  readonly token: string;
  rotate(): void;
  onRotate(cb: (token: string) => void): () => void;
  close(): Promise<void>;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

function tokenMatches(expected: Buffer, req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization;
  let presented: string | undefined;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) presented = auth.slice(7).trim();
  else if (typeof req.headers['x-crewdeck-token'] === 'string') presented = req.headers['x-crewdeck-token'];
  if (!presented) return false;
  const got = Buffer.from(presented, 'utf8');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function resolveProjectId(requested: unknown): string | null {
  try {
    const db = getDatabase();
    if (typeof requested === 'string' && requested.length > 0 && requested.length <= 128 && db.getProject(requested)) {
      return requested;
    }
    return db.getLastProject()?.id ?? null;
  } catch {
    return null;
  }
}

function fromLabel(v: unknown): string {
  return v === 'cli' || v === 'mcp' ? v : 'agent';
}

export function startBrowserBridge(): Promise<BridgeHandle> {
  let token = randomBytes(32).toString('base64url');
  let expected = Buffer.from(token, 'utf8');
  let prevExpected: Buffer | null = null;
  let prevUntil = 0;
  const listeners = new Set<(t: string) => void>();
  const rotate = (): void => {
    prevExpected = expected;
    prevUntil = Date.now() + GRACE_MS;
    token = randomBytes(32).toString('base64url');
    expected = Buffer.from(token, 'utf8');
    for (const cb of listeners) {
      try {
        cb(token);
      } catch {
        /* ignore listener errors */
      }
    }
  };
  const rotateTimer = setInterval(rotate, ROTATE_MS);
  rotateTimer.unref();
  let bucket = RATE_BURST;
  let lastRefill = Date.now();
  const allow = (): boolean => {
    const now = Date.now();
    bucket = Math.min(RATE_BURST, bucket + ((now - lastRefill) / 1000) * RATE_PER_SEC);
    lastRefill = now;
    if (bucket < 1) return false;
    bucket -= 1;
    return true;
  };
  let hostOk = new Set<string>();

  const server = http.createServer((req, res) => {
    void (async () => {
      if (!hostOk.has(req.headers.host ?? '')) return send(res, 421, { ok: false, error: 'bad host' });
      if (req.headers.origin !== undefined) return send(res, 403, { ok: false, error: 'origin not allowed' });
      if (!allow()) return send(res, 429, { ok: false, error: 'rate limited' });
      const authed =
        tokenMatches(expected, req) ||
        (prevExpected !== null && Date.now() < prevUntil && tokenMatches(prevExpected, req));
      if (!authed) return send(res, 401, { ok: false, error: 'unauthorized' });

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/state')
        return send(res, 200, { ok: true, state: browserEngine.state() });
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (url.pathname !== '/run') return send(res, 404, { ok: false, error: 'not found' });
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(res, 415, { ok: false, error: 'expected application/json' });
      }

      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        return send(res, 400, { ok: false, error: err instanceof Error ? err.message : 'bad request' });
      }
      const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      const cmd = parseBrowserCommand(o.command);
      const s = browserEngine.state();
      if (!cmd) {
        const result: BrowserResult = {
          ok: false,
          action: 'status',
          url: s.url,
          title: s.title,
          error: 'invalid command',
        };
        return send(res, 400, result);
      }
      try {
        const result = await browserEngine.run(cmd, {
          projectId: resolveProjectId(o.projectId),
          from: fromLabel(o.from),
        });
        return send(res, 200, result);
      } catch (err) {
        const now = browserEngine.state();
        const result: BrowserResult = {
          ok: false,
          action: cmd.action,
          url: now.url,
          title: now.title,
          error: err instanceof Error ? err.message : String(err),
        };
        return send(res, 503, result);
      }
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { ok: false, error: 'internal error' });
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      hostOk = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      resolve({
        url: `http://127.0.0.1:${port}`,
        get token() {
          return token;
        },
        rotate,
        onRotate: (cb: (t: string) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        close: () =>
          new Promise<void>((done) => {
            clearInterval(rotateTimer);
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
