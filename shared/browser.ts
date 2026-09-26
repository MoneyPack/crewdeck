// Pure browser-automation helpers shared by the Electron engine, the HTTP
// bridge, the CLI and the MCP server. No Electron / Node imports here.

/* ------------------------------------------------------------------ */
/* Accessibility tree → @eN refs                                       */
/* ------------------------------------------------------------------ */

/** Subset of CDP `Accessibility.AXNode` we rely on. */
export interface AXValue {
  type?: string;
  value?: unknown;
}
export interface AXProperty {
  name: string;
  value: AXValue;
}
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface RefEntry {
  ref: string;
  role: string;
  name: string;
  backendNodeId: number;
}

export interface Snapshot {
  /** Rendered, agent-readable tree. */
  text: string;
  /** ref id (without "@") → target. */
  refs: Record<string, RefEntry>;
  /** Number of refs issued. */
  count: number;
  /** True when output was cut at `maxLines`. */
  truncated: boolean;
}

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
  'textarea',
]);

/** Named nodes worth showing (and addressing) even though they are not interactive. */
export const CONTEXT_ROLES: ReadonlySet<string> = new Set([
  'heading',
  'img',
  'image',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'navigation',
  'main',
  'form',
  'region',
  'banner',
  'contentinfo',
  'table',
  'list',
  'tablist',
  'menu',
  'menubar',
  'tree',
  'grid',
  'article',
]);

const STATE_PROPS = ['checked', 'selected', 'expanded', 'pressed', 'disabled', 'required', 'focused'] as const;

const clean = (s: unknown, max = 120): string => {
  if (typeof s !== 'string' && typeof s !== 'number') return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

function describe(node: AXNode, role: string, name: string, ref: string | null): string {
  const parts: string[] = [];
  if (ref) parts.push(`@${ref}`);
  parts.push(role);
  if (name) parts.push(quote(name));
  const attrs: string[] = [];
  if (role === 'heading') {
    const level = prop(node, 'level');
    if (typeof level === 'number') attrs.push(`level=${level}`);
  }
  const value = clean(node.value?.value, 80);
  if (value && value !== name) attrs.push(`value=${quote(value)}`);
  for (const p of STATE_PROPS) {
    const v = prop(node, p);
    if (v === true || v === 'true') attrs.push(p);
    else if (p === 'checked' && v === 'mixed') attrs.push('checked=mixed');
  }
  if (attrs.length) parts.push(`[${attrs.join(' ')}]`);
  return parts.join(' ');
}

export interface SnapshotOptions {
  /** Only emit interactive nodes (still indented by kept ancestors). */
  interactiveOnly?: boolean;
  /** Hard cap on emitted lines. */
  maxLines?: number;
}

/**
 * Turn a flat CDP AX node list into an indented tree where every interactive
 * or meaningful named node gets a stable-per-snapshot `@eN` ref.
 */
export function buildSnapshot(nodes: readonly AXNode[], opts: SnapshotOptions = {}): Snapshot {
  const maxLines = opts.maxLines ?? 1500;
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  const hasParent = new Set<string>();
  for (const n of nodes) for (const c of n.childIds ?? []) hasParent.add(c);
  const roots = nodes.filter((n) => !n.parentId && !hasParent.has(n.nodeId));
  if (!roots.length && nodes.length) roots.push(nodes[0]!);

  const refs: Record<string, RefEntry> = {};
  const lines: string[] = [];
  let count = 0;
  let truncated = false;
  const seen = new Set<string>();

  const visit = (id: string, depth: number): void => {
    if (truncated || seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    const role = clean(node.role?.value, 40).toLowerCase();
    const name = clean(node.name?.value);
    const interactive = !node.ignored && INTERACTIVE_ROLES.has(role);
    const contextual = !node.ignored && !opts.interactiveOnly && CONTEXT_ROLES.has(role) && (name !== '' || role === 'main' || role === 'dialog');
    const textLeaf = !node.ignored && !opts.interactiveOnly && role === 'statictext' && name !== '' && !parentIsNamed(node);
    let childDepth = depth;
    if (interactive || contextual || textLeaf) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      let ref: string | null = null;
      if ((interactive || contextual) && typeof node.backendDOMNodeId === 'number') {
        count += 1;
        ref = `e${count}`;
        refs[ref] = { ref, role, name, backendNodeId: node.backendDOMNodeId };
      }
      const indent = '  '.repeat(depth);
      lines.push(textLeaf ? `${indent}text ${quote(name)}` : `${indent}${describe(node, role, name, ref)}`);
      childDepth = depth + 1;
      // An interactive control's own label text is already in its name.
      if (interactive) return;
    }
    for (const c of node.childIds ?? []) visit(c, childDepth);
  };

  const parentIsNamed = (node: AXNode): boolean => {
    const p = node.parentId ? byId.get(node.parentId) : undefined;
    if (!p) return false;
    const r = clean(p.role?.value, 40).toLowerCase();
    return (INTERACTIVE_ROLES.has(r) || r === 'heading') && clean(p.name?.value) !== '';
  };

  for (const r of roots) visit(r.nodeId, 0);
  if (truncated) lines.push(`… truncated at ${maxLines} lines`);
  return { text: lines.join('\n'), refs, count, truncated };
}

/* ------------------------------------------------------------------ */
/* Refs                                                                */
/* ------------------------------------------------------------------ */

/** Accepts `@e3`, `e3`, `ref=e3`; returns `e3` or null. */
export function parseRef(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const m = /^(?:@|ref=)?(e[1-9]\d{0,5})$/.exec(input.trim());
  return m ? m[1]! : null;
}

/* ------------------------------------------------------------------ */
/* Snapshot diff                                                       */
/* ------------------------------------------------------------------ */

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  /** Unified-ish text: "+ line" / "- line". Empty when unchanged. */
  text: string;
  changed: boolean;
}

/** Refs renumber between snapshots; compare lines with refs stripped. */
const diffKey = (line: string): string => line.replace(/@e\d+ /g, '').trimEnd();

/** Line diff via LCS over ref-agnostic keys; falls back to multiset diff for huge inputs. */
export function diffSnapshots(before: string, after: string): SnapshotDiff {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const ka = a.map(diffKey);
  const kb = b.map(diffKey);
  const added: string[] = [];
  const removed: string[] = [];
  const out: string[] = [];

  if (a.length * b.length > 4_000_000) {
    const counts = new Map<string, number>();
    for (const k of ka) counts.set(k, (counts.get(k) ?? 0) + 1);
    for (let j = 0; j < b.length; j++) {
      const c = counts.get(kb[j]!) ?? 0;
      if (c > 0) counts.set(kb[j]!, c - 1);
      else added.push(b[j]!);
    }
    const bc = new Map<string, number>();
    for (const k of kb) bc.set(k, (bc.get(k) ?? 0) + 1);
    for (let i = 0; i < a.length; i++) {
      const c = bc.get(ka[i]!) ?? 0;
      if (c > 0) bc.set(ka[i]!, c - 1);
      else removed.push(a[i]!);
    }
    for (const r of removed) out.push(`- ${r.trim()}`);
    for (const x of added) out.push(`+ ${x.trim()}`);
  } else {
    const n = a.length;
    const m = b.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = ka[i] === kb[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ka[i] === kb[j]) {
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i * w + j + 1]! >= dp[(i + 1) * w + j]!)) {
        added.push(b[j]!);
        out.push(`+ ${b[j]!.trim()}`);
        j++;
      } else {
        removed.push(a[i]!);
        out.push(`- ${a[i]!.trim()}`);
        i++;
      }
    }
  }
  return { added, removed, text: out.join('\n'), changed: out.length > 0 };
}

/* ------------------------------------------------------------------ */
/* Annotated screenshot labels                                         */
/* ------------------------------------------------------------------ */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Annotation {
  ref: string;
  box: Box;
  label: Box & { text: string };
}

const overlaps = (p: Box, q: Box): boolean =>
  p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;

/**
 * Place a small "eN" tag per target box inside the viewport, preferring the
 * top-left corner just above the box and nudging down/right to avoid overlap.
 */
export function layoutAnnotations(
  targets: ReadonlyArray<{ ref: string; box: Box }>,
  viewport: { width: number; height: number },
  charWidth = 7,
  labelHeight = 14,
): Annotation[] {
  const placed: Box[] = [];
  const out: Annotation[] = [];
  const visible = targets.filter(
    (t) =>
      t.box.width > 0 &&
      t.box.height > 0 &&
      t.box.x < viewport.width &&
      t.box.y < viewport.height &&
      t.box.x + t.box.width > 0 &&
      t.box.y + t.box.height > 0,
  );
  for (const t of visible) {
    const width = t.ref.length * charWidth + 6;
    const clampX = (x: number): number => Math.max(0, Math.min(viewport.width - width, x));
    const clampY = (y: number): number => Math.max(0, Math.min(viewport.height - labelHeight, y));
    const candidates: Array<{ x: number; y: number }> = [
      { x: t.box.x, y: t.box.y - labelHeight },
      { x: t.box.x, y: t.box.y },
      { x: t.box.x + t.box.width - width, y: t.box.y },
      { x: t.box.x, y: t.box.y + t.box.height },
    ];
    let chosen: Box | null = null;
    for (const c of candidates) {
      const b = { x: clampX(c.x), y: clampY(c.y), width, height: labelHeight };
      if (!placed.some((p) => overlaps(p, b))) {
        chosen = b;
        break;
      }
    }
    if (!chosen) {
      // Slide right along the first candidate row until free (bounded).
      let b = { x: clampX(t.box.x), y: clampY(t.box.y - labelHeight), width, height: labelHeight };
      for (let k = 0; k < 40 && placed.some((p) => overlaps(p, b)); k++) {
        const nx = b.x + width + 2;
        b = nx + width > viewport.width ? { ...b, x: 0, y: clampY(b.y + labelHeight + 2) } : { ...b, x: nx };
      }
      chosen = b;
    }
    placed.push(chosen);
    out.push({ ref: t.ref, box: t.box, label: { ...chosen, text: t.ref } });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* URL + keys                                                          */
/* ------------------------------------------------------------------ */

/** Normalise address-bar / agent input. Returns null for disallowed schemes. */
export function normalizeUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 8192) return null;
  if (/^about:blank$/i.test(s)) return 'about:blank';
  if (/^data:/i.test(s)) return s;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (hasScheme) {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
      return null;
    }
  }
  // "scheme:..." without "//" — only allow real host:port (dotted host, localhost, or IP).
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    const hostPort = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+):\d{1,5}(\/|\?|#|$)/i.test(s);
    if (!hostPort) return null;
  }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s);
  try {
    return new URL(`${local ? 'http' : 'https'}://${s}`).href;
  } catch {
    return null;
  }
}

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers: number;
}

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

// CDP Input modifier bits.
const MOD_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

/** Parse "Enter", "a", "Control+a", "Shift+Tab" into a CDP key definition. */
export function parseKey(input: unknown): KeyDef | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > 40) return null;
  let parts: string[];
  let keyPart: string;
  if (raw === '+') {
    parts = [];
    keyPart = '+';
  } else if (raw.endsWith('++')) {
    parts = raw.slice(0, -2).split('+');
    keyPart = '+';
  } else {
    parts = raw.split('+');
    keyPart = parts.pop() ?? '';
  }
  if (!keyPart || parts.some((p) => p === '')) return null;
  let modifiers = 0;
  for (const m of parts) {
    const bit = MOD_BITS[m.toLowerCase()];
    if (bit === undefined) return null;
    modifiers |= bit;
  }
  const named = NAMED_KEYS[keyPart.toLowerCase()];
  if (named) {
    const def: KeyDef = { key: named.key, code: named.code, keyCode: named.keyCode, modifiers };
    if (named.text && !(modifiers & 7)) def.text = named.text;
    return def;
  }
  if (/^F([1-9]|1[0-2])$/i.test(keyPart)) {
    const n = Number(keyPart.slice(1));
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n, modifiers };
  }
  if ([...keyPart].length !== 1) return null;
  const ch = keyPart;
  const upper = ch.toUpperCase();
  let code = '';
  let keyCode = 0;
  if (/^[a-z]$/i.test(ch)) {
    code = `Key${upper}`;
    keyCode = upper.charCodeAt(0);
  } else if (/^\d$/.test(ch)) {
    code = `Digit${ch}`;
    keyCode = ch.charCodeAt(0);
  }
  const def: KeyDef = { key: ch, code, keyCode, modifiers };
  if (!(modifiers & 7)) def.text = modifiers & 8 ? upper : ch;
  return def;
}

/* ------------------------------------------------------------------ */
/* Command protocol (HTTP bridge, CLI, MCP, IPC all speak this)        */
/* ------------------------------------------------------------------ */

export type BrowserCommand =
  | { action: 'open'; url: string }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }
  | { action: 'snapshot'; interactiveOnly: boolean }
  | { action: 'click'; ref: string }
  | { action: 'fill'; ref: string; text: string }
  | { action: 'type'; text: string }
  | { action: 'press'; key: string }
  | { action: 'hover'; ref: string }
  | { action: 'scroll'; dx: number; dy: number; ref: string | null }
  | { action: 'wait'; text: string | null; ref: string | null; timeoutMs: number }
  | { action: 'screenshot'; fullPage: boolean; annotate: boolean }
  | { action: 'console'; clear: boolean }
  | { action: 'status' };

export type BrowserAction = BrowserCommand['action'];

export const BROWSER_ACTIONS: readonly BrowserAction[] = [
  'open',
  'back',
  'forward',
  'reload',
  'snapshot',
  'click',
  'fill',
  'type',
  'press',
  'hover',
  'scroll',
  'wait',
  'screenshot',
  'console',
  'status',
];

export const MAX_BROWSER_TEXT = 20_000;
export const MAX_WAIT_MS = 30_000;

const num = (v: unknown, dflt: number, lo: number, hi: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
};
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1';
const str = (v: unknown, max = MAX_BROWSER_TEXT): string | null => (typeof v === 'string' && v.length <= max ? v : null);

/** Validate untrusted input into a command. Returns null when malformed. */
export function parseBrowserCommand(raw: unknown): BrowserCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  switch (o.action) {
    case 'open': {
      const url = normalizeUrl(o.url);
      return url ? { action: 'open', url } : null;
    }
    case 'back':
    case 'forward':
    case 'reload':
    case 'status':
      return { action: o.action };
    case 'snapshot':
      return { action: 'snapshot', interactiveOnly: bool(o.interactiveOnly) };
    case 'click':
    case 'hover': {
      const ref = parseRef(o.ref);
      return ref ? { action: o.action, ref } : null;
    }
    case 'fill': {
      const ref = parseRef(o.ref);
      const text = str(o.text ?? o.value);
      return ref && text !== null ? { action: 'fill', ref, text } : null;
    }
    case 'type': {
      const text = str(o.text ?? o.value);
      return text ? { action: 'type', text } : null;
    }
    case 'press': {
      const key = str(o.key, 40);
      return key && parseKey(key) ? { action: 'press', key } : null;
    }
    case 'scroll': {
      const ref = o.ref === undefined || o.ref === null ? null : parseRef(o.ref);
      if (o.ref !== undefined && o.ref !== null && !ref) return null;
      return { action: 'scroll', dx: num(o.dx, 0, -100_000, 100_000), dy: num(o.dy, ref ? 0 : 600, -100_000, 100_000), ref };
    }
    case 'wait': {
      const text = o.text === undefined || o.text === null ? null : str(o.text, 500);
      const ref = o.ref === undefined || o.ref === null ? null : parseRef(o.ref);
      if ((o.text != null && !text) || (o.ref != null && !ref)) return null;
      if (!text && !ref) return null;
      return { action: 'wait', text, ref, timeoutMs: num(o.timeoutMs, 5000, 0, MAX_WAIT_MS) };
    }
    case 'screenshot':
      return { action: 'screenshot', fullPage: bool(o.fullPage), annotate: bool(o.annotate) };
    case 'console':
      return { action: 'console', clear: bool(o.clear) };
    default:
      return null;
  }
}

/** Parse CLI argv (`click @e3`, `fill @e2 hello world`, `screenshot --full --annotate`). */
export function parseCliArgs(argv: readonly string[]): BrowserCommand | null {
  const [action, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const pos = rest.filter((a) => !a.startsWith('--'));
  switch (action) {
    case 'open':
    case 'goto':
    case 'navigate':
      return parseBrowserCommand({ action: 'open', url: pos[0] });
    case 'snapshot':
      return parseBrowserCommand({ action: 'snapshot', interactiveOnly: flags.has('--interactive') || flags.has('-i') || rest.includes('-i') });
    case 'click':
    case 'hover':
      return parseBrowserCommand({ action, ref: pos[0] });
    case 'fill':
      return parseBrowserCommand({ action: 'fill', ref: pos[0], text: pos.slice(1).join(' ') });
    case 'type':
      return parseBrowserCommand({ action: 'type', text: pos.join(' ') });
    case 'press':
      return parseBrowserCommand({ action: 'press', key: pos[0] });
    case 'scroll': {
      const ref = pos[0] && parseRef(pos[0]) ? pos.shift() : undefined;
      const dir = pos[0];
      const amount = Number(pos[1] ?? 600);
      const map: Record<string, [number, number]> = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] };
      const d = dir ? map[dir] : [0, 1];
      if (!d) return null;
      return parseBrowserCommand({ action: 'scroll', ref, dx: d[0] * amount, dy: d[1] * amount });
    }
    case 'wait': {
      const timeout = rest.find((a) => a.startsWith('--timeout='));
      const target = pos.join(' ');
      const ref = parseRef(target);
      return parseBrowserCommand({
        action: 'wait',
        ref: ref ?? undefined,
        text: ref ? undefined : target || undefined,
        timeoutMs: timeout ? timeout.slice('--timeout='.length) : undefined,
      });
    }
    case 'screenshot':
      return parseBrowserCommand({ action: 'screenshot', fullPage: flags.has('--full'), annotate: flags.has('--annotate') });
    case 'console':
      return parseBrowserCommand({ action: 'console', clear: flags.has('--clear') });
    case 'back':
    case 'forward':
    case 'reload':
    case 'status':
      return { action };
    default:
      return null;
  }
}

/** Result envelope returned by every command. */
export interface BrowserResult {
  ok: boolean;
  action: BrowserAction;
  url: string;
  title: string;
  /** Human/agent readable text (snapshot, diff, console dump…). */
  text?: string;
  /** Snapshot diff after a mutating action. */
  diff?: string;
  /** Absolute path of a written PNG. */
  screenshotPath?: string;
  error?: string;
}

/** One-line summary for the routing log preview. */
export function summarizeCommand(cmd: BrowserCommand): string {
  switch (cmd.action) {
    case 'open':
      return `open ${cmd.url}`;
    case 'click':
    case 'hover':
      return `${cmd.action} @${cmd.ref}`;
    case 'fill':
      return `fill @${cmd.ref} (${cmd.text.length} chars)`;
    case 'type':
      return `type (${cmd.text.length} chars)`;
    case 'press':
      return `press ${cmd.key}`;
    case 'scroll':
      return `scroll ${cmd.ref ? `@${cmd.ref} ` : ''}${cmd.dx},${cmd.dy}`;
    case 'wait':
      return `wait ${cmd.ref ? `@${cmd.ref}` : cmd.text ? quote(cmd.text) : ''}`.trim();
    case 'screenshot':
      return `screenshot${cmd.fullPage ? ' full' : ''}${cmd.annotate ? ' annotated' : ''}`;
    case 'snapshot':
      return cmd.interactiveOnly ? 'snapshot -i' : 'snapshot';
    default:
      return cmd.action;
  }
}

/** Actions that change page state and therefore return a before/after diff. */
export const MUTATING_ACTIONS: ReadonlySet<BrowserAction> = new Set(['click', 'fill', 'type', 'press']);

/** Live state of the browser pane, pushed to the renderer on every change. */
export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  visible: boolean;
}
