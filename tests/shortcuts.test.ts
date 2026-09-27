import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  codeLabel,
  findShortcut,
  formatCombo,
  matchCombo,
  shortcutHint,
  type KeyLike,
} from '../shared/shortcuts';

const key = (code: string, mods: Partial<Omit<KeyLike, 'code'>> = {}): KeyLike => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

test('matchCombo requires exact modifiers', () => {
  const combo = { code: 'KeyT', mod: true, shift: true };
  assert.equal(matchCombo(key('KeyT', { ctrlKey: true, shiftKey: true }), combo), true);
  assert.equal(matchCombo(key('KeyT', { ctrlKey: true }), combo), false);
  assert.equal(matchCombo(key('KeyT', { ctrlKey: true, shiftKey: true, altKey: true }), combo), false);
  assert.equal(matchCombo(key('KeyY', { ctrlKey: true, shiftKey: true }), combo), false);
});

test('matchCombo maps mod to Cmd on mac and rejects the other platform modifier', () => {
  const combo = { code: 'KeyT', mod: true, shift: true };
  assert.equal(matchCombo(key('KeyT', { metaKey: true, shiftKey: true }), combo, true), true);
  assert.equal(matchCombo(key('KeyT', { ctrlKey: true, shiftKey: true }), combo, true), false);
  assert.equal(matchCombo(key('KeyT', { ctrlKey: true, metaKey: true, shiftKey: true }), combo, false), false);
});

test('findShortcut resolves actions', () => {
  assert.equal(findShortcut(key('Digit1', { altKey: true })), 'focusPane1');
  assert.equal(findShortcut(key('Digit1', { altKey: true, shiftKey: true })), 'layout1');
  assert.equal(findShortcut(key('F1')), 'help');
  assert.equal(findShortcut(key('Slash', { ctrlKey: true, shiftKey: true })), 'help');
  assert.equal(findShortcut(key('PageDown', { ctrlKey: true })), 'nextTab');
  assert.equal(findShortcut(key('KeyT')), null);
  assert.equal(findShortcut(key('KeyC', { ctrlKey: true })), null);
});

test('codeLabel', () => {
  assert.equal(codeLabel('KeyT'), 'T');
  assert.equal(codeLabel('Digit1'), '1');
  assert.equal(codeLabel('PageDown'), 'PgDn');
  assert.equal(codeLabel('Slash'), '/');
  assert.equal(codeLabel('F1'), 'F1');
});

test('formatCombo and shortcutHint', () => {
  assert.deepEqual(formatCombo({ code: 'KeyT', mod: true, shift: true }), ['Ctrl', 'Shift', 'T']);
  assert.deepEqual(formatCombo({ code: 'KeyT', mod: true, shift: true }, true), ['⌘', '⇧', 'T']);
  assert.deepEqual(formatCombo({ code: 'Digit2', alt: true }), ['Alt', '2']);
  assert.equal(shortcutHint('newTerminal'), 'Ctrl+Shift+T');
  assert.equal(shortcutHint('newTerminal', true), '⌘⇧T');
  assert.equal(shortcutHint('help'), 'F1');
});

test('no duplicate combos and every group is known', () => {
  const seen = new Set<string>();
  for (const s of SHORTCUTS) {
    assert.ok(SHORTCUT_GROUPS.includes(s.group), s.action);
    assert.ok(s.combos.length > 0, s.action);
    for (const c of s.combos) {
      const id = `${c.mod ? 'M' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}:${c.code}`;
      assert.ok(!seen.has(id), `duplicate combo ${id}`);
      seen.add(id);
    }
  }
});

test('shortcuts avoid plain terminal control keys', () => {
  // Ctrl+<letter> without Shift is reserved for the shell (^C, ^D, ^R, ...).
  for (const s of SHORTCUTS) for (const c of s.combos) assert.ok(!(c.mod && !c.shift && /^Key/.test(c.code)), s.action);
});
