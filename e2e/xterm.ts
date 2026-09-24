import type { Locator } from '@playwright/test';

/**
 * Read a pane's terminal text straight from the xterm buffer. The WebGL renderer draws to a
 * canvas (no `.xterm-rows` DOM), so tests read `__xterm` exposed on `.pane-body` instead.
 * `tail` limits the read to the last N buffer lines (cheap polling under heavy output).
 */
export const paneText = (pane: Locator, tail = 400): Promise<string> =>
  pane.locator('.pane-body').evaluate((el, n) => {
    type Line = { translateToString(trim?: boolean): string };
    type Buf = { length: number; getLine(i: number): Line | undefined };
    const term = (el as unknown as { __xterm?: { buffer: { active: Buf } } }).__xterm;
    if (!term) return '';
    const b = term.buffer.active;
    const out: string[] = [];
    for (let i = Math.max(0, b.length - n); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n');
  }, tail);
