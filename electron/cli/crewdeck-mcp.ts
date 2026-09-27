/**
 * `crewdeck-mcp` — stdio MCP server exposing crewdeck's browser pane as tools.
 * stdout is the protocol channel: never write logs to it.
 */
import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { BrowserCommand } from '../../shared/browser';
import { formatResult, runCommand } from './bridgeClient';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

async function exec(command: BrowserCommand, withImage = false): Promise<{ content: Content[]; isError?: boolean }> {
  try {
    const r = await runCommand(command, 'mcp');
    const content: Content[] = [{ type: 'text', text: formatResult(r) }];
    if (withImage && r.ok && r.screenshotPath) {
      const png = await fs.readFile(r.screenshotPath);
      content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    }
    return r.ok ? { content } : { content, isError: true };
  } catch (err) {
    return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
  }
}

const ref = z.string().describe('element ref from a snapshot, e.g. @e3');
const server = new McpServer({ name: 'crewdeck-browser', version: '1.0.0' });

server.registerTool(
  'browser_open',
  { description: 'Navigate the crewdeck browser pane to a URL.', inputSchema: { url: z.string() } },
  ({ url }) => exec({ action: 'open', url }),
);
for (const action of ['back', 'forward', 'reload', 'status'] as const) {
  server.registerTool(`browser_${action}`, { description: `Browser ${action}.`, inputSchema: {} }, () =>
    exec({ action }),
  );
}
server.registerTool(
  'browser_snapshot',
  {
    description: 'Accessibility snapshot of the page. Interactive elements get @eN refs usable by other tools.',
    inputSchema: { interactiveOnly: z.boolean().optional() },
  },
  ({ interactiveOnly }) => exec({ action: 'snapshot', interactiveOnly: interactiveOnly ?? false }),
);
server.registerTool('browser_click', { description: 'Click an element by ref.', inputSchema: { ref } }, (a) =>
  exec({ action: 'click', ref: a.ref }),
);
server.registerTool('browser_hover', { description: 'Hover an element by ref.', inputSchema: { ref } }, (a) =>
  exec({ action: 'hover', ref: a.ref }),
);
server.registerTool(
  'browser_fill',
  { description: 'Replace the value of an input by ref.', inputSchema: { ref, text: z.string() } },
  (a) => exec({ action: 'fill', ref: a.ref, text: a.text }),
);
server.registerTool(
  'browser_type',
  { description: 'Type text into the focused element.', inputSchema: { text: z.string() } },
  (a) => exec({ action: 'type', text: a.text }),
);
server.registerTool(
  'browser_press',
  { description: 'Press a key or chord, e.g. Enter, Control+a.', inputSchema: { key: z.string() } },
  (a) => exec({ action: 'press', key: a.key }),
);
server.registerTool(
  'browser_scroll',
  {
    description: 'Scroll the page (or an element by ref).',
    inputSchema: {
      direction: z.enum(['down', 'up', 'left', 'right']),
      amount: z.number().optional(),
      ref: z.string().optional(),
    },
  },
  ({ direction, amount, ref: r }) => {
    const n = amount ?? 600;
    const dx = direction === 'right' ? n : direction === 'left' ? -n : 0;
    const dy = direction === 'down' ? n : direction === 'up' ? -n : 0;
    return exec({ action: 'scroll', dx, dy, ref: r ?? null });
  },
);
server.registerTool(
  'browser_wait',
  {
    description: 'Wait for text to appear or a ref to exist.',
    inputSchema: { text: z.string().optional(), ref: z.string().optional(), timeoutMs: z.number().optional() },
  },
  (a) => exec({ action: 'wait', text: a.text ?? null, ref: a.ref ?? null, timeoutMs: a.timeoutMs ?? 5000 }),
);
server.registerTool(
  'browser_screenshot',
  {
    description: 'PNG screenshot of the pane; annotate overlays @eN ref labels.',
    inputSchema: { fullPage: z.boolean().optional(), annotate: z.boolean().optional() },
  },
  (a) => exec({ action: 'screenshot', fullPage: a.fullPage ?? false, annotate: a.annotate ?? false }, true),
);
server.registerTool(
  'browser_console',
  { description: 'Read recent console messages.', inputSchema: { clear: z.boolean().optional() } },
  (a) => exec({ action: 'console', clear: a.clear ?? false }),
);

void server.connect(new StdioServerTransport()).catch((err: unknown) => {
  process.stderr.write(`crewdeck-mcp: ${String(err)}\n`);
  process.exitCode = 1;
});
