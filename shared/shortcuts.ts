/**
 * App-level keyboard shortcuts. Combos match on `KeyboardEvent.code` (physical key), so they
 * work regardless of keyboard layout and Shift never changes which digit/letter is matched.
 * `mod` is Ctrl on Windows/Linux and Cmd on macOS.
 */

export type ShortcutAction =
  | 'newTerminal'
  | 'closeTerminal'
  | 'nextTab'
  | 'prevTab'
  | 'layout1'
  | 'layout2'
  | 'layout4'
  | 'focusPane1'
  | 'focusPane2'
  | 'focusPane3'
  | 'focusPane4'
  | 'focusComposer'
  | 'toggleGit'
  | 'toggleLog'
  | 'help';

export interface Combo {
  code: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type ShortcutGroup = 'Terminals' | 'Layout' | 'Panels';

export interface Shortcut {
  action: ShortcutAction;
  label: string;
  group: ShortcutGroup;
  /** First combo is the canonical one shown in hints. */
  combos: Combo[];
}

/** Minimal slice of KeyboardEvent used for matching (keeps this module DOM-free and testable). */
export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { action: 'newTerminal', label: 'New terminal', group: 'Terminals', combos: [{ code: 'KeyT', mod: true, shift: true }] },
  { action: 'closeTerminal', label: 'Close active terminal', group: 'Terminals', combos: [{ code: 'KeyW', mod: true, shift: true }] },
  { action: 'nextTab', label: 'Next tab', group: 'Terminals', combos: [{ code: 'PageDown', mod: true }] },
  { action: 'prevTab', label: 'Previous tab', group: 'Terminals', combos: [{ code: 'PageUp', mod: true }] },
  { action: 'focusComposer', label: 'Focus composer', group: 'Terminals', combos: [{ code: 'KeyM', mod: true, shift: true }] },
  { action: 'layout1', label: 'Single pane', group: 'Layout', combos: [{ code: 'Digit1', alt: true, shift: true }] },
  { action: 'layout2', label: 'Two panes', group: 'Layout', combos: [{ code: 'Digit2', alt: true, shift: true }] },
  { action: 'layout4', label: 'Four panes', group: 'Layout', combos: [{ code: 'Digit4', alt: true, shift: true }] },
  { action: 'focusPane1', label: 'Focus pane 1', group: 'Layout', combos: [{ code: 'Digit1', alt: true }] },
  { action: 'focusPane2', label: 'Focus pane 2', group: 'Layout', combos: [{ code: 'Digit2', alt: true }] },
  { action: 'focusPane3', label: 'Focus pane 3', group: 'Layout', combos: [{ code: 'Digit3', alt: true }] },
  { action: 'focusPane4', label: 'Focus pane 4', group: 'Layout', combos: [{ code: 'Digit4', alt: true }] },
  { action: 'toggleGit', label: 'Toggle git panel', group: 'Panels', combos: [{ code: 'KeyG', mod: true, shift: true }] },
  { action: 'toggleLog', label: 'Toggle routing log', group: 'Panels', combos: [{ code: 'KeyL', mod: true, shift: true }] },
  { action: 'help', label: 'Keyboard shortcuts', group: 'Panels', combos: [{ code: 'F1' }, { code: 'Slash', mod: true, shift: true }] },
];

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Terminals', 'Layout', 'Panels'];

/** True when the event's modifiers and physical key exactly match `combo`. */
export function matchCombo(e: KeyLike, combo: Combo, mac = false): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  // The non-mod platform modifier (Cmd on Windows, Ctrl on macOS) must be up.
  const other = mac ? e.ctrlKey : e.metaKey;
  return (
    e.code === combo.code &&
    mod === !!combo.mod &&
    e.shiftKey === !!combo.shift &&
    e.altKey === !!combo.alt &&
    !other
  );
}

export function findShortcut(e: KeyLike, mac = false, list: readonly Shortcut[] = SHORTCUTS): ShortcutAction | null {
  for (const s of list) if (s.combos.some((c) => matchCombo(e, c, mac))) return s.action;
  return null;
}

const CODE_LABELS: Record<string, string> = {
  PageDown: 'PgDn',
  PageUp: 'PgUp',
  Slash: '/',
  Escape: 'Esc',
  Enter: 'Enter',
  Space: 'Space',
  Tab: 'Tab',
};

/** Human label for a physical key code: KeyT → T, Digit1 → 1, F1 → F1. */
export function codeLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return CODE_LABELS[code] ?? code;
}

/** Key caps for a combo, in platform order (e.g. ['Ctrl', 'Shift', 'T'] or ['⌘', '⇧', 'T']). */
export function formatCombo(combo: Combo, mac = false): string[] {
  const keys: string[] = [];
  if (combo.mod) keys.push(mac ? '⌘' : 'Ctrl');
  if (combo.alt) keys.push(mac ? '⌥' : 'Alt');
  if (combo.shift) keys.push(mac ? '⇧' : 'Shift');
  keys.push(codeLabel(combo.code));
  return keys;
}

/** Canonical combo text for tooltips, e.g. "Ctrl+Shift+T". */
export function shortcutHint(action: ShortcutAction, mac = false): string {
  const s = SHORTCUTS.find((x) => x.action === action);
  return s ? formatCombo(s.combos[0], mac).join(mac ? '' : '+') : '';
}
