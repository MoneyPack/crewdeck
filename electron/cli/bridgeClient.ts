/** Minimal HTTP client for the crewdeck browser bridge (shared by CLI + MCP). */
import type { BrowserCommand, BrowserResult } from '../../shared/browser';

export class BridgeError extends Error {}

export function bridgeEnv(): { url: string; token: string } {
  const url = process.env.CREWDECK_BROWSER_URL;
  const token = process.env.CREWDECK_BROWSER_TOKEN;
  if (!url || !token) {
    throw new BridgeError(
      'crewdeck browser bridge not found: run this from a crewdeck terminal (CREWDECK_BROWSER_URL / CREWDECK_BROWSER_TOKEN unset)',
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}

export async function runCommand(command: BrowserCommand, from: 'cli' | 'mcp'): Promise<BrowserResult> {
  const { url, token } = bridgeEnv();
  let res: Response;
  try {
    res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ command, from, projectId: process.env.CREWDECK_PROJECT_ID || undefined }),
    });
  } catch (err) {
    throw new BridgeError(`cannot reach crewdeck at ${url}: ${(err as Error).message}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new BridgeError(`bridge returned HTTP ${res.status} with a non-JSON body`);
  }
  if (body && typeof body === 'object' && 'ok' in body && 'action' in body) return body as BrowserResult;
  const msg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : '';
  throw new BridgeError(`bridge HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
}

export function formatResult(r: BrowserResult): string {
  const out: string[] = [];
  if (!r.ok) out.push(`error: ${r.error ?? 'failed'}`);
  if (r.text) out.push(r.text);
  if (r.diff) out.push(`diff: ${JSON.stringify(r.diff)}`);
  if (r.screenshotPath) out.push(`screenshot: ${r.screenshotPath}`);
  out.push(`[${r.action}] ${r.title || '(untitled)'} — ${r.url || 'about:blank'}`);
  return out.join('\n');
}
