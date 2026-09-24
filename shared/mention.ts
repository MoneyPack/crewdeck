// @mention parsing for the composer bar (CD-14).
// Grammar: one or more leading `@handle` tokens, then the message.
//   "@claude fix the test"        -> [claude]
//   "@claude @codex review this"  -> [claude, codex]
//   "@all git status"             -> every terminal
// Handles are derived from terminal titles (see mentionHandles) and matched case-insensitively.

export interface MentionTerminal {
  id: string;
  title: string;
}

export interface MentionTarget extends MentionTerminal {
  handle: string;
}

export type MentionResult =
  | { ok: true; targets: MentionTarget[]; message: string; broadcast: boolean }
  | { ok: false; error: string; start: number; end: number };

export const BROADCAST_HANDLE = 'all';

const TOKEN = /@([^\s@]*)/y;

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'term';
}

/** Unique, stable-by-order handle per terminal. Duplicates get -2, -3...; `all` is reserved. */
export function mentionHandles(terminals: readonly MentionTerminal[]): MentionTarget[] {
  const used = new Set<string>([BROADCAST_HANDLE]);
  return terminals.map((t) => {
    const base = slugify(t.title);
    let handle = base;
    for (let n = 2; used.has(handle); n++) handle = `${base}-${n}`;
    used.add(handle);
    return { id: t.id, title: t.title, handle };
  });
}

/** Handles (plus `all`) starting with `prefix`, for autocomplete. */
export function mentionCompletions(prefix: string, terminals: readonly MentionTerminal[]): string[] {
  const p = prefix.replace(/^@/, '').toLowerCase();
  const all = [...mentionHandles(terminals).map((t) => t.handle), BROADCAST_HANDLE];
  return all.filter((h) => h.startsWith(p));
}

export function parseMention(input: string, terminals: readonly MentionTerminal[]): MentionResult {
  const handles = mentionHandles(terminals);
  const byHandle = new Map(handles.map((t) => [t.handle, t]));
  const targets = new Map<string, MentionTarget>();
  let broadcast = false;
  let pos = input.length - input.trimStart().length;

  if (input[pos] !== '@') {
    return { ok: false, error: 'Start with @<terminal> or @all', start: pos, end: Math.max(pos, input.length) };
  }

  while (input[pos] === '@') {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(input);
    if (!m) break;
    const start = pos;
    const end = pos + m[0].length;
    // Allow "@claude: do x" / "@claude, @codex ...".
    const raw = m[1].replace(/[:,]+$/, '');
    const name = raw.toLowerCase();
    if (!name) return { ok: false, error: 'Missing terminal name after @', start, end };
    if (name === BROADCAST_HANDLE) {
      broadcast = true;
    } else {
      const hit = byHandle.get(name);
      if (!hit) {
        const known = handles.map((t) => `@${t.handle}`).join(', ') || 'none';
        return { ok: false, error: `Unknown terminal @${raw} (known: ${known})`, start, end };
      }
      targets.set(hit.id, hit);
    }
    pos = end;
    while (pos < input.length && /\s/.test(input[pos])) pos++;
  }

  const message = input.slice(pos).trimEnd();
  if (!message) return { ok: false, error: 'Message is empty', start: pos, end: input.length };
  if (broadcast) {
    if (handles.length === 0) return { ok: false, error: 'No terminals to broadcast to', start: 0, end: pos };
    return { ok: true, targets: handles, message, broadcast: true };
  }
  return { ok: true, targets: [...targets.values()], message, broadcast: false };
}
