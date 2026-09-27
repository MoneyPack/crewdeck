import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSnapshot,
  diffSnapshots,
  layoutAnnotations,
  normalizeUrl,
  parseBrowserCommand,
  parseCliArgs,
  parseKey,
  parseRef,
  summarizeCommand,
  type AXNode,
} from '../shared/browser';

const v = (value: unknown) => ({ type: 'string', value });

function tree(): AXNode[] {
  return [
    { nodeId: '1', role: v('RootWebArea'), name: v('Page'), childIds: ['2', '3', '6', '8', '9'] },
    {
      nodeId: '2',
      parentId: '1',
      role: v('heading'),
      name: v('Title'),
      backendDOMNodeId: 20,
      properties: [{ name: 'level', value: { type: 'integer', value: 1 } }],
      childIds: ['2a'],
    },
    { nodeId: '2a', parentId: '2', role: v('StaticText'), name: v('Title') },
    {
      nodeId: '3',
      parentId: '1',
      role: v('button'),
      name: v('Save'),
      backendDOMNodeId: 30,
      childIds: ['4'],
      properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }],
    },
    { nodeId: '4', parentId: '3', role: v('StaticText'), name: v('Save') },
    {
      nodeId: '6',
      parentId: '1',
      role: v('textbox'),
      name: v('Email'),
      value: v('a@b.c'),
      backendDOMNodeId: 60,
      properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
    },
    { nodeId: '8', parentId: '1', role: v('StaticText'), name: v('hello   world') },
    { nodeId: '9', parentId: '1', ignored: true, role: v('button'), name: v('Hidden'), backendDOMNodeId: 90 },
  ];
}

test('buildSnapshot issues refs and renders attrs', () => {
  const s = buildSnapshot(tree());
  assert.equal(s.count, 3);
  assert.equal(s.truncated, false);
  assert.deepEqual(s.text.split('\n'), [
    '@e1 heading "Title" [level=1]',
    '@e2 button "Save" [disabled]',
    '@e3 textbox "Email" [value="a@b.c" focused]',
    'text "hello world"',
  ]);
  assert.deepEqual(s.refs.e2, { ref: 'e2', role: 'button', name: 'Save', backendNodeId: 30 });
  assert.ok(!s.text.includes('Hidden'));
});

test('buildSnapshot interactiveOnly and truncation', () => {
  const i = buildSnapshot(tree(), { interactiveOnly: true });
  assert.deepEqual(i.text.split('\n'), ['@e1 button "Save" [disabled]', '@e2 textbox "Email" [value="a@b.c" focused]']);
  const t = buildSnapshot(tree(), { maxLines: 2 });
  assert.equal(t.truncated, true);
  assert.match(t.text, /… truncated at 2 lines$/);
  assert.equal(t.text.split('\n').length, 3);
});

test('buildSnapshot handles mixed checkbox, missing backend id, quotes', () => {
  const s = buildSnapshot([
    { nodeId: 'r', role: v('RootWebArea'), childIds: ['c', 'l'] },
    {
      nodeId: 'c',
      parentId: 'r',
      role: v('checkbox'),
      name: v('All "x"'),
      backendDOMNodeId: 5,
      properties: [{ name: 'checked', value: { type: 'tristate', value: 'mixed' } }],
    },
    { nodeId: 'l', parentId: 'r', role: v('link'), name: v('No backend') },
  ]);
  assert.equal(s.text, '@e1 checkbox "All \\"x\\"" [checked=mixed]\nlink "No backend"');
  assert.equal(s.count, 1);
});

test('parseRef', () => {
  assert.equal(parseRef('@e3'), 'e3');
  assert.equal(parseRef('e12'), 'e12');
  assert.equal(parseRef('ref=e7'), 'e7');
  assert.equal(parseRef(' @e1 '), 'e1');
  assert.equal(parseRef('e0'), null);
  assert.equal(parseRef('@x3'), null);
  assert.equal(parseRef(3), null);
});

test('diffSnapshots is ref-agnostic', () => {
  const a = '@e1 button "A"\n@e2 text "old"';
  const b = '@e5 button "A"\n@e6 text "new"';
  const d = diffSnapshots(a, b);
  assert.equal(d.changed, true);
  assert.deepEqual(d.added, ['@e6 text "new"']);
  assert.deepEqual(d.removed, ['@e2 text "old"']);
  assert.match(d.text, /^- @e2 text "old"$/m);
  assert.match(d.text, /^\+ @e6 text "new"$/m);
  assert.equal(diffSnapshots(a, '@e9 button "A"\n@e3 text "old"').changed, false);
  assert.equal(diffSnapshots('', '').text, '');
});

test('diffSnapshots large-input fallback', () => {
  const a = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join('\n');
  const b = `${a}\nextra`;
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, []);
});

test('layoutAnnotations avoids overlap and filters offscreen', () => {
  const vp = { width: 200, height: 100 };
  const targets = [
    { ref: 'e1', box: { x: 10, y: 30, width: 50, height: 20 } },
    { ref: 'e2', box: { x: 10, y: 30, width: 50, height: 20 } },
    { ref: 'e3', box: { x: 10, y: 30, width: 50, height: 20 } },
    { ref: 'e4', box: { x: 300, y: 10, width: 10, height: 10 } },
    { ref: 'e5', box: { x: 10, y: 10, width: 0, height: 10 } },
  ];
  const out = layoutAnnotations(targets, vp);
  assert.deepEqual(
    out.map((a) => a.ref),
    ['e1', 'e2', 'e3'],
  );
  for (let i = 0; i < out.length; i++) {
    const p = out[i]!.label;
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.width <= vp.width && p.y + p.height <= vp.height);
    for (let j = i + 1; j < out.length; j++) {
      const q = out[j]!.label;
      const hit = p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
      assert.equal(hit, false, `${out[i]!.ref} overlaps ${out[j]!.ref}`);
    }
  }
  const top = layoutAnnotations([{ ref: 'e1', box: { x: 0, y: 0, width: 20, height: 20 } }], vp);
  assert.equal(top[0]!.label.y, 0);
});

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('localhost:5173/x'), 'http://localhost:5173/x');
  assert.equal(normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(normalizeUrl('http://a.test/p?q=1'), 'http://a.test/p?q=1');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
  assert.equal(normalizeUrl('data:text/html,<p>x</p>'), 'data:text/html,<p>x</p>');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl('ftp://x.test'), null);
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl('a'.repeat(9000)), null);
});

test('parseKey', () => {
  assert.deepEqual(parseKey('Enter'), { key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0, text: '\r' });
  assert.deepEqual(parseKey('Control+a'), { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 });
  assert.deepEqual(parseKey('Shift+a'), { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 8, text: 'A' });
  assert.equal(parseKey('F5')?.keyCode, 116);
  assert.equal(parseKey('Ctrl+Shift+Tab')?.modifiers, 10);
  assert.equal(parseKey('Ctrl++')?.key, '+');
  assert.equal(parseKey('Hyper+a'), null);
  assert.equal(parseKey('abc'), null);
  assert.equal(parseKey(''), null);
});

test('parseBrowserCommand validates', () => {
  assert.deepEqual(parseBrowserCommand({ action: 'open', url: 'x.test' }), { action: 'open', url: 'https://x.test/' });
  assert.equal(parseBrowserCommand({ action: 'open', url: 'javascript:1' }), null);
  assert.deepEqual(parseBrowserCommand({ action: 'click', ref: '@e2' }), { action: 'click', ref: 'e2' });
  assert.equal(parseBrowserCommand({ action: 'click', ref: 'nope' }), null);
  assert.deepEqual(parseBrowserCommand({ action: 'fill', ref: 'e1', text: '' }), {
    action: 'fill',
    ref: 'e1',
    text: '',
  });
  assert.deepEqual(parseBrowserCommand({ action: 'fill', ref: 'e1', value: 'x' }), {
    action: 'fill',
    ref: 'e1',
    text: 'x',
  });
  assert.deepEqual(parseBrowserCommand({ action: 'type', value: 'y' }), { action: 'type', text: 'y' });
  assert.equal(parseBrowserCommand({ action: 'type', text: '' }), null);
  assert.equal(parseBrowserCommand({ action: 'type', text: 'x'.repeat(20_001) }), null);
  assert.equal(parseBrowserCommand({ action: 'press', key: 'Nope+x' }), null);
  assert.deepEqual(parseBrowserCommand({ action: 'scroll' }), { action: 'scroll', dx: 0, dy: 600, ref: null });
  assert.deepEqual(parseBrowserCommand({ action: 'scroll', ref: 'e1' }), { action: 'scroll', dx: 0, dy: 0, ref: 'e1' });
  assert.equal(parseBrowserCommand({ action: 'scroll', ref: 'bad' }), null);
  assert.deepEqual(parseBrowserCommand({ action: 'wait', text: 'Done', timeoutMs: 99_999 }), {
    action: 'wait',
    text: 'Done',
    ref: null,
    timeoutMs: 30_000,
  });
  assert.equal(parseBrowserCommand({ action: 'wait' }), null);
  assert.equal(parseBrowserCommand({ action: 'wait', text: '' }), null);
  assert.deepEqual(parseBrowserCommand({ action: 'screenshot', annotate: 'true' }), {
    action: 'screenshot',
    fullPage: false,
    annotate: true,
  });
  assert.equal(parseBrowserCommand({ action: 'eval' }), null);
  assert.equal(parseBrowserCommand(null), null);
});

test('parseCliArgs', () => {
  assert.deepEqual(parseCliArgs(['goto', 'localhost:3000']), { action: 'open', url: 'http://localhost:3000/' });
  assert.deepEqual(parseCliArgs(['snapshot', '-i']), { action: 'snapshot', interactiveOnly: true });
  assert.deepEqual(parseCliArgs(['fill', '@e2', 'hello', 'world']), { action: 'fill', ref: 'e2', text: 'hello world' });
  assert.deepEqual(parseCliArgs(['scroll', 'up', '200']), { action: 'scroll', dx: 0, dy: -200, ref: null });
  assert.deepEqual(parseCliArgs(['scroll', '@e4', 'right']), { action: 'scroll', dx: 600, dy: 0, ref: 'e4' });
  assert.equal(parseCliArgs(['scroll', 'sideways']), null);
  assert.deepEqual(parseCliArgs(['wait', 'Saved', 'ok', '--timeout=1000']), {
    action: 'wait',
    text: 'Saved ok',
    ref: null,
    timeoutMs: 1000,
  });
  assert.deepEqual(parseCliArgs(['wait', '@e3']), { action: 'wait', text: null, ref: 'e3', timeoutMs: 5000 });
  assert.equal(parseCliArgs(['wait']), null);
  assert.deepEqual(parseCliArgs(['screenshot', '--full', '--annotate']), {
    action: 'screenshot',
    fullPage: true,
    annotate: true,
  });
  assert.deepEqual(parseCliArgs(['console', '--clear']), { action: 'console', clear: true });
  assert.deepEqual(parseCliArgs(['back']), { action: 'back' });
  assert.equal(parseCliArgs([]), null);
});

test('summarizeCommand', () => {
  assert.equal(summarizeCommand({ action: 'click', ref: 'e3' }), 'click @e3');
  assert.equal(summarizeCommand({ action: 'fill', ref: 'e1', text: 'secret' }), 'fill @e1 (6 chars)');
  assert.equal(summarizeCommand({ action: 'wait', text: 'Hi', ref: null, timeoutMs: 1 }), 'wait "Hi"');
  assert.equal(summarizeCommand({ action: 'screenshot', fullPage: true, annotate: true }), 'screenshot full annotated');
  assert.equal(summarizeCommand({ action: 'status' }), 'status');
});
