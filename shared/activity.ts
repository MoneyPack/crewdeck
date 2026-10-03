/**
 * Agent activity heuristic shared by panes and pipelines.
 * ponytail: output-recency + prompt-regex. Good enough for Claude/Codex/Gemini/OpenCode/shells;
 * upgrade to per-agent OSC/prompt markers if a CLI misreports.
 */
export type Activity = 'working' | 'waiting' | 'idle' | 'off';

/** Output newer than this means the process is still producing. */
export const WORKING_WINDOW_MS = 1500;
/** Silence longer than this (without a prompt) counts as done for pipelines. */
export const IDLE_DONE_MS = 10_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;

/** Last non-empty line, ANSI stripped. */
export function tailLine(buf: string): string {
  const lines = buf.replace(ANSI, '').split(/\r?\n|\r/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return l;
  }
  return '';
}

const PROMPT = /(?:[>$❯›%#]|\(y\/n\)|\[y\/n\]|\[Y\/n\]|\(yes\/no\)|y\/n\?|\?|allow\?|proceed\?|continue\?|:)\s*$/i;
const ASKING = /\b(allow|approve|permission|confirm|proceed|continue|yes|y\/n|accept|choose|select|press enter)\b/i;

/** Does the visible tail look like the process is waiting on a human? */
export function looksWaiting(buf: string): boolean {
  const last = tailLine(buf);
  if (!last) return false;
  if (PROMPT.test(last)) return true;
  return ASKING.test(last) && last.length < 160;
}

export function classify(now: number, lastOutputAt: number, buf: string, alive: boolean): Activity {
  if (!alive) return 'off';
  if (now - lastOutputAt < WORKING_WINDOW_MS) return 'working';
  return looksWaiting(buf) ? 'waiting' : 'idle';
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  working: 'working',
  waiting: 'needs you',
  idle: 'idle',
  off: 'off',
};
